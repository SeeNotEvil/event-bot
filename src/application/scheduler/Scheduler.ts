import { DateTime } from 'luxon';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { z } from 'zod';
import type { Database, SchedulesTable } from '../../db/types.js';
import { formatDateForDatabase, formatUtcDateTimeInZone, parseLocalDateTime } from '../notifications/time.js';
import { enqueueOnce } from './enqueue.js';
import { agentTaskPayloadSchema, createScheduleSchema, decodeJson, deleteScheduleSchema,
  recurrenceSchema, scheduleOnceSchema, searchSchedulesSchema, updateScheduleSchema, type Recurrence } from './schemas.js';
import { occurrence } from './time.js';

export type ScheduleOwner = { userId: number; chatId: number; timezone: string };

function ruleOf(row: Selectable<SchedulesTable>): Recurrence {
  return recurrenceSchema.parse({ frequency: row.recurrence, time: row.local_time.slice(0, 5), weekdays: decodeJson(row.weekdays) });
}

async function eventVersion(database: Kysely<Database>, chatId: number, eventId: number | null) {
  if (eventId === null) return 1;
  const event = await database.selectFrom('events').select('deadline_version')
    .where('chat_id', '=', chatId).where('id', '=', eventId).where('status', '=', 'active').forUpdate().executeTakeFirst();
  if (!event) throw new Error('EVENT_NOT_FOUND_OR_INACTIVE');
  return Number(event.deadline_version);
}

async function mapSchedule(database: Kysely<Database>, row: Selectable<SchedulesTable>) {
  const next = await database.selectFrom('notifications').select('remind_at_utc')
    .where('schedule_id', '=', Number(row.id)).where('schedule_version', '=', Number(row.version))
    .where('status', '=', 'pending').orderBy('remind_at_utc').limit(1).executeTakeFirst();
  return { id: Number(row.id), eventId: row.event_id === null ? null : Number(row.event_id), kind: row.kind,
    instruction: agentTaskPayloadSchema.parse(decodeJson(row.payload)).instruction,
    recurrence: ruleOf(row), timezone: row.timezone, enabled: Boolean(row.enabled), version: Number(row.version),
    nextUnqueuedAt: row.next_run_at_utc === null ? null : formatUtcDateTimeInZone(row.next_run_at_utc, row.timezone),
    nextNotificationAt: next ? formatUtcDateTimeInZone(next.remind_at_utc, row.timezone) : null };
}

export class Scheduler {
  public static enqueueOnce = enqueueOnce;
  public constructor(private readonly database: Kysely<Database>) {}

  public async once(owner: ScheduleOwner, now: Date, rawInput: z.infer<typeof scheduleOnceSchema>) {
    const input = scheduleOnceSchema.parse(rawInput);
    const at = parseLocalDateTime(input.remindAt, owner.timezone);
    if (!at) throw new Error('INVALID_LOCAL_TIME');
    if (at.toMillis() <= now.getTime()) throw new Error('REMINDER_NOT_IN_FUTURE');
    return this.database.transaction().execute(async (transaction) => {
      const version = await eventVersion(transaction, owner.chatId, input.eventId);
      const id = await enqueueOnce(transaction, { created_by_user_id: owner.userId, chat_id: owner.chatId,
        event_id: input.eventId, deadline_version: version, kind: 'agent_task',
        payload: JSON.stringify({ instruction: input.instruction }), remind_at_utc: formatDateForDatabase(at),
        timezone: owner.timezone, status: 'pending', source: 'manual', lock_token: null, last_error: null,
        updated_at: now });
      return { notificationId: id, remindAt: input.remindAt, timezone: owner.timezone };
    });
  }

  public async create(owner: ScheduleOwner, now: Date, rawInput: z.infer<typeof createScheduleSchema>) {
    const input = createScheduleSchema.parse(rawInput);
    const next = occurrence(input.recurrence, owner.timezone, DateTime.fromJSDate(now), 'next');
    return this.database.transaction().execute(async (transaction) => {
      await eventVersion(transaction, owner.chatId, input.eventId);
      const result = await transaction.insertInto('schedules').values({ created_by_user_id: owner.userId,
        chat_id: owner.chatId, event_id: input.eventId, kind: 'agent_task', payload: JSON.stringify({ instruction: input.instruction }),
        recurrence: input.recurrence.frequency, local_time: input.recurrence.time,
        weekdays: input.recurrence.weekdays === null ? null : JSON.stringify(input.recurrence.weekdays), timezone: owner.timezone,
        next_run_at_utc: formatDateForDatabase(next), updated_at: now,
      }).executeTakeFirstOrThrow();
      if (result.insertId === undefined) throw new Error('Database did not return a schedule ID');
      const row = await transaction.selectFrom('schedules').selectAll().where('id', '=', Number(result.insertId)).executeTakeFirstOrThrow();
      return mapSchedule(transaction, row);
    });
  }

  public async search(owner: ScheduleOwner, rawInput: z.infer<typeof searchSchedulesSchema>) {
    const input = searchSchedulesSchema.parse(rawInput);
    let query = this.database.selectFrom('schedules').selectAll()
      .where('chat_id', '=', owner.chatId).where('created_by_user_id', '=', owner.userId);
    if (input.scheduleId !== null) query = query.where('id', '=', input.scheduleId);
    if (input.enabled !== null) query = query.where('enabled', '=', Number(input.enabled));
    if (input.beforeId !== null) query = query.where('id', '<', input.beforeId);
    const limit = input.limit ?? 50;
    const rows = await query.orderBy('id', 'desc').limit(limit + 1).execute();
    const schedules = await Promise.all(rows.slice(0, limit).map((row) => mapSchedule(this.database, row)));
    return { schedules, nextBeforeId: rows.length > limit ? schedules.at(-1)!.id : null };
  }

  public async update(owner: ScheduleOwner, now: Date, rawInput: z.infer<typeof updateScheduleSchema>) {
    const input = updateScheduleSchema.parse(rawInput);
    return this.change(owner, now, input, input);
  }

  public async delete(owner: ScheduleOwner, now: Date, rawInput: z.infer<typeof deleteScheduleSchema>) {
    return this.change(owner, now, deleteScheduleSchema.parse(rawInput), null);
  }

  private async change(owner: ScheduleOwner, now: Date, ref: z.infer<typeof deleteScheduleSchema>, input: z.infer<typeof updateScheduleSchema> | null) {
    return this.database.transaction().execute(async (transaction) => {
      // Domain operations acquire events before schedules before notifications.
      const reference = await transaction.selectFrom('schedules').select('event_id')
        .where('id', '=', ref.scheduleId).where('chat_id', '=', owner.chatId)
        .where('created_by_user_id', '=', owner.userId).executeTakeFirst();
      const eventIds = [...new Set([reference?.event_id, input?.eventId].filter((id): id is number => id != null))].sort((a, b) => a - b);
      if (eventIds.length) await transaction.selectFrom('events').select('id').where('id', 'in', eventIds).orderBy('id').forUpdate().execute();
      const row = await transaction.selectFrom('schedules').selectAll().where('id', '=', ref.scheduleId)
        .where('chat_id', '=', owner.chatId).where('created_by_user_id', '=', owner.userId).forUpdate().executeTakeFirst();
      if (!row) return { success: false, reason: 'NOT_FOUND' as const, schedule: null };
      if (Number(row.version) !== ref.expectedVersion) return { success: false, reason: 'VERSION_CONFLICT' as const, schedule: await mapSchedule(transaction, row) };
      if (input?.enabled) await eventVersion(transaction, owner.chatId, input.eventId);
      const version = Number(row.version) + 1;
      await transaction.updateTable('schedules').set({ enabled: Number(input?.enabled ?? false), version,
        next_run_at_utc: input?.enabled ? formatDateForDatabase(occurrence(input.recurrence, owner.timezone, DateTime.fromJSDate(now), 'next')) : null,
        ...(input ? { event_id: input.eventId, payload: JSON.stringify({ instruction: input.instruction }),
          recurrence: input.recurrence.frequency, local_time: input.recurrence.time,
          weekdays: input.recurrence.weekdays === null ? null : JSON.stringify(input.recurrence.weekdays), timezone: owner.timezone } : {}),
        updated_at: now,
      }).where('id', '=', ref.scheduleId).execute();
      await transaction.updateTable('notifications').set({ status: 'cancelled', lock_token: null, locked_at: null, retry_at: null, updated_at: now })
        .where('schedule_id', '=', ref.scheduleId).where('status', '=', 'pending').execute();
      const updated = await transaction.selectFrom('schedules').selectAll().where('id', '=', ref.scheduleId).executeTakeFirstOrThrow();
      return { success: true, reason: null, schedule: await mapSchedule(transaction, updated) };
    });
  }

  /** Keep the latest missed occurrence plus exactly one future occurrence per rule. */
  public async replenish(now: Date, batchSize: number, signal?: AbortSignal) {
    const nowSql = formatDateForDatabase(now);
    const processed: number[] = [];
    let enqueued = 0;
    for (let index = 0; index < batchSize && !signal?.aborted; index++) {
      const result = await this.database.transaction().execute(async (transaction) => {
        let candidates = transaction.selectFrom('schedules').selectAll().where('enabled', '=', 1)
          .where((eb) => eb.or([eb('next_run_at_utc', '<=', nowSql), eb.not(eb.exists(
            eb.selectFrom('notifications').select('id').whereRef('schedule_id', '=', 'schedules.id')
              .whereRef('schedule_version', '=', 'schedules.version').where('status', '=', 'pending').where('remind_at_utc', '>', nowSql),
          ))])).orderBy('next_run_at_utc').orderBy('id').limit(1);
        if (processed.length) candidates = candidates.where('schedules.id', 'not in', processed);
        // Read a candidate, lock its event first, then recheck under the schedule lock.
        const candidate = await candidates.executeTakeFirst();
        if (!candidate) return null;
        if (candidate.event_id !== null) {
          const event = await transaction.selectFrom('events').select(['id', 'status'])
            .where('id', '=', candidate.event_id).forUpdate().skipLocked().executeTakeFirst();
          if (!event) return { id: Number(candidate.id), count: 0 };
        }
        const row = await transaction.selectFrom('schedules').selectAll().where('id', '=', Number(candidate.id))
          .where('enabled', '=', 1).forUpdate().skipLocked().executeTakeFirst();
        if (!row) return { id: Number(candidate.id), count: 0 };
        // A concurrent edit can change the event between the candidate read and lock.
        if (row.event_id !== candidate.event_id) return { id: Number(row.id), count: 0 };
        const rule = ruleOf(row);
        const reference = DateTime.fromJSDate(now);
        const latest = occurrence(rule, row.timezone, reference, 'previous', true);
        await transaction.updateTable('notifications').set({ status: 'skipped', lock_token: null, locked_at: null, retry_at: null, updated_at: now })
          .where('schedule_id', '=', Number(row.id)).where('schedule_version', '=', Number(row.version))
          .where('status', '=', 'pending').where('remind_at_utc', '<', formatDateForDatabase(latest)).execute();
        const cursor = DateTime.fromSQL(row.next_run_at_utc!, { zone: 'utc' });
        const future = await transaction.selectFrom('notifications').select('id').where('schedule_id', '=', Number(row.id))
          .where('schedule_version', '=', Number(row.version)).where('status', '=', 'pending').where('remind_at_utc', '>', nowSql).forUpdate().executeTakeFirst();
        let count = 0;
        let next: DateTime = cursor;
        const version = await eventVersion(transaction, Number(row.chat_id), row.event_id);
        const enqueue = async (at: DateTime) => {
          await enqueueOnce(transaction, { created_by_user_id: Number(row.created_by_user_id), chat_id: Number(row.chat_id),
            event_id: row.event_id, deadline_version: version, kind: 'agent_task', payload: JSON.stringify(agentTaskPayloadSchema.parse(decodeJson(row.payload))),
            schedule_id: Number(row.id), schedule_version: Number(row.version), remind_at_utc: formatDateForDatabase(at),
            timezone: row.timezone, status: 'pending', source: 'automatic', lock_token: null, last_error: null, updated_at: now });
          count++;
        };
        if (cursor.toMillis() <= now.getTime()) {
          await enqueue(latest);
          next = occurrence(rule, row.timezone, reference, 'next');
        }
        if (!future) {
          await enqueue(next);
          next = occurrence(rule, row.timezone, next, 'next');
        }
        await transaction.updateTable('schedules').set({ next_run_at_utc: formatDateForDatabase(next), updated_at: now })
          .where('id', '=', Number(row.id)).execute();
        return { id: Number(row.id), count };
      });
      if (!result) break;
      processed.push(result.id);
      enqueued += result.count;
    }
    return { checked: processed.length, enqueued };
  }
}

/** Called inside event transactions, after locking the event. */
export async function changeEventSchedules(database: Kysely<Database>, eventIds: number[], now: Date, stop: boolean) {
  if (!eventIds.length) return 0;
  const rows = await database.selectFrom('schedules').selectAll().where('event_id', 'in', eventIds)
    .where('enabled', '=', 1).orderBy('id').forUpdate().execute();
  for (const row of rows) {
    await database.updateTable('schedules').set({ version: sql<number>`version + 1`, enabled: stop ? 0 : 1,
      next_run_at_utc: stop ? null : formatDateForDatabase(occurrence(ruleOf(row), row.timezone, DateTime.fromJSDate(now), 'next')),
      updated_at: now }).where('id', '=', Number(row.id)).execute();
  }
  return rows.length;
}
