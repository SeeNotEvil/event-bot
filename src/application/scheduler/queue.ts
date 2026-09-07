import { DateTime } from 'luxon';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { localDateTimeSchema } from '../notifications/schemas.js';
import { formatDateForDatabase, formatUtcDateTimeInZone, parseLocalDateTime } from '../notifications/time.js';
import { agentTaskPayloadSchema, decodeJson, schedulerIdSchema as id } from './schemas.js';
import type { ScheduleOwner } from './Scheduler.js';

export const queuedNotificationSchema = z.object({
  id, version: id, eventId: id.nullable(), eventTitle: z.string().nullable(), scheduleId: id.nullable(),
  kind: z.enum(['reminder', 'completion_check', 'agent_task']), instruction: z.string().nullable(),
  remindAt: localDateTimeSchema, timezone: z.string(),
  status: z.enum(['pending', 'sent', 'cancelled', 'skipped']), source: z.enum(['manual', 'automatic']),
});
export const searchQueueSchema = z.object({
  eventId: id.nullable(), statuses: z.array(queuedNotificationSchema.shape.status).min(1).max(4).nullable(),
  remindFrom: localDateTimeSchema.nullable(), remindTo: localDateTimeSchema.nullable(),
  limit: z.number().int().min(1).max(100).nullable(),
  notificationId: id.nullable(), scheduleId: id.nullable(), beforeId: id.nullable(),
});
export const queuePageSchema = z.object({ notifications: z.array(queuedNotificationSchema), nextBeforeId: id.nullable() });
export const updateNotificationSchema = z.object({
  notificationId: id, expectedVersion: id, remindAt: localDateTimeSchema,
  instruction: agentTaskPayloadSchema.shape.instruction.nullable(),
});
export const queueChangeSchema = z.object({ success: z.boolean(),
  reason: z.enum(['NOT_FOUND_OR_NOT_PENDING', 'VERSION_CONFLICT', 'EDIT_SCHEDULE_INSTEAD']).nullable(),
  notification: queuedNotificationSchema.nullable() });

function queryQueue(database: Kysely<Database>, owner: ScheduleOwner) {
  return database.selectFrom('notifications').leftJoin('events', 'events.id', 'notifications.event_id')
    .selectAll('notifications').select('events.title as event_title')
    .where('notifications.chat_id', '=', owner.chatId)
    .where('notifications.kind', 'in', ['reminder', 'completion_check', 'agent_task'])
    .where((eb) => eb.or([eb('notifications.kind', '!=', 'agent_task'), eb('notifications.created_by_user_id', '=', owner.userId)]));
}
type QueueRow = Awaited<ReturnType<ReturnType<typeof queryQueue>['execute']>>[number];
function mapQueue(row: QueueRow) {
  return queuedNotificationSchema.parse({ id: Number(row.id), version: Number(row.version),
    eventId: row.event_id === null ? null : Number(row.event_id), eventTitle: row.event_title,
    scheduleId: row.schedule_id === null ? null : Number(row.schedule_id), kind: row.kind,
    instruction: row.kind === 'agent_task' ? agentTaskPayloadSchema.parse(decodeJson(row.payload)).instruction : null,
    remindAt: formatUtcDateTimeInZone(row.remind_at_utc, row.timezone), timezone: row.timezone,
    status: row.status, source: row.source });
}

function localUtc(value: string, timezone: string) {
  const parsed = parseLocalDateTime(value, timezone);
  if (!parsed) throw new Error('INVALID_LOCAL_TIME');
  return formatDateForDatabase(parsed);
}

export async function searchQueue(database: Kysely<Database>, owner: ScheduleOwner, rawInput: z.infer<typeof searchQueueSchema>) {
  const input = searchQueueSchema.parse(rawInput);
  let query = queryQueue(database, owner).where('notifications.status', 'in', input.statuses ?? ['pending']);
  if (input.eventId !== null) query = query.where('notifications.event_id', '=', input.eventId);
  if (input.notificationId !== null) query = query.where('notifications.id', '=', input.notificationId);
  if (input.scheduleId !== null) query = query.where('notifications.schedule_id', '=', input.scheduleId);
  if (input.beforeId !== null) query = query.where('notifications.id', '<', input.beforeId);
  const from = input.remindFrom === null ? null : localUtc(input.remindFrom, owner.timezone);
  const to = input.remindTo === null ? null : localUtc(input.remindTo, owner.timezone);
  if (from !== null && to !== null && from > to) throw new Error('remindFrom must not follow remindTo');
  if (from !== null) query = query.where('notifications.remind_at_utc', '>=', from);
  if (to !== null) query = query.where('notifications.remind_at_utc', '<=', to);
  const limit = input.limit ?? 50;
  const rows = await query.orderBy('notifications.id', 'desc').limit(limit + 1).execute();
  const notifications = rows.slice(0, limit).map(mapQueue);
  return { notifications, nextBeforeId: rows.length > limit ? notifications.at(-1)!.id : null };
}

export async function changeNotification(database: Kysely<Database>, owner: ScheduleOwner, now: Date,
  notificationId: number, update: z.infer<typeof updateNotificationSchema> | null) {
  if (update) {
    updateNotificationSchema.parse(update);
    if (DateTime.fromSQL(localUtc(update.remindAt, owner.timezone), { zone: 'utc' }).toMillis() <= now.getTime()) {
      throw new Error('REMINDER_NOT_IN_FUTURE');
    }
  }
  return database.transaction().execute(async (transaction) => {
    const reference = await queryQueue(transaction, owner).where('notifications.id', '=', notificationId).executeTakeFirst();
    if (!reference) return { success: false, reason: 'NOT_FOUND_OR_NOT_PENDING' as const, notification: null };
    if (reference.event_id !== null) await transaction.selectFrom('events').select('id').where('id', '=', reference.event_id).forUpdate().execute();
    if (reference.schedule_id !== null) await transaction.selectFrom('schedules').select('id').where('id', '=', reference.schedule_id).forUpdate().execute();
    const row = await queryQueue(transaction, owner).where('notifications.id', '=', notificationId)
      .where('notifications.status', '=', 'pending').forUpdate().executeTakeFirst();
    if (!row) return { success: false, reason: 'NOT_FOUND_OR_NOT_PENDING' as const, notification: null };
    if (update && Number(row.version) !== update.expectedVersion) return { success: false, reason: 'VERSION_CONFLICT' as const, notification: mapQueue(row) };
    if (update && row.schedule_id !== null) return { success: false, reason: 'EDIT_SCHEDULE_INSTEAD' as const, notification: mapQueue(row) };
    if (update && ((row.kind === 'agent_task') !== (update.instruction !== null))) throw new Error('Provide instruction only for agent_task');
    await transaction.updateTable('notifications').set({ version: sql<number>`version + 1`, lock_token: null,
      locked_at: null, retry_at: null, last_error: null, updated_at: now,
      ...(update ? { remind_at_utc: localUtc(update.remindAt, owner.timezone), timezone: owner.timezone,
        ...(update.instruction === null ? {} : { payload: JSON.stringify({ instruction: update.instruction }) }) }
        : { status: 'cancelled' as const }),
    }).where('id', '=', notificationId).execute();
    const changed = await queryQueue(transaction, owner).where('notifications.id', '=', notificationId).executeTakeFirstOrThrow();
    return { success: true, reason: null, notification: mapQueue(changed) };
  });
}
