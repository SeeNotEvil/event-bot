import { DateTime } from 'luxon';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, EventsTable } from '../../db/types.js';
import { touchCalendarList } from '../schedule/calendarList.js';
import { localDateTimeSchema } from './schemas.js';
import { formatDateForDatabase, parseLocalDateTime } from './time.js';

export type ReminderMode = 'default' | 'custom' | 'off';
export type NotificationTarget = { kind: 'reminder' | 'completion_check'; at: string; source: 'automatic' | 'manual' };

export function planNotifications(
  dates: { dateFrom: string | null; dateTo: string | null }, timezone: string, currentDateTime: string,
  mode: ReminderMode, reminderTimes: string[], checkCompletion: boolean,
): NotificationTarget[] {
  const now = DateTime.fromISO(currentDateTime, { setZone: true }).setZone(timezone);
  if (!now.isValid) throw new Error('INVALID_LOCAL_TIME');
  const targets: NotificationTarget[] = [];
  if (mode === 'custom') {
    for (const time of reminderTimes) {
      const at = parseLocalDateTime(time, timezone);
      if (!at) throw new Error('INVALID_LOCAL_TIME');
      if (at.toMillis() <= now.toMillis()) throw new Error('REMINDER_NOT_IN_FUTURE');
      targets.push({ kind: 'reminder', at: formatDateForDatabase(at), source: 'manual' });
    }
  } else if (mode === 'default' && dates.dateFrom !== null) {
    for (const date of new Set([dates.dateFrom, dates.dateTo ?? dates.dateFrom])) {
      const at = DateTime.fromISO(date, { zone: timezone }).minus({ days: 1 }).set({ hour: 10 });
      if (at.toMillis() > now.toMillis()) targets.push({ kind: 'reminder', at: formatDateForDatabase(at), source: 'automatic' });
    }
  }
  if (checkCompletion && dates.dateFrom !== null) {
    let at = DateTime.fromISO(dates.dateTo ?? dates.dateFrom, { zone: timezone }).plus({ days: 1 }).set({ hour: 10 });
    if (at.toMillis() <= now.toMillis()) {
      at = now.startOf('day').set({ hour: 10 });
      if (at.toMillis() <= now.toMillis()) at = at.plus({ days: 1 });
    }
    targets.push({ kind: 'completion_check', at: formatDateForDatabase(at), source: 'automatic' });
  }
  return targets;
}

export async function replaceNotificationPlan(
  database: Kysely<Database>, event: Selectable<EventsTable>, timezone: string, now: string,
  mode: ReminderMode, reminderTimes: string[], checkCompletion: boolean,
) {
  const targets = planNotifications({ dateFrom: event.date_from, dateTo: event.date_to }, timezone, now, mode, reminderTimes, checkCompletion);
  const existing = await database.selectFrom('notifications').selectAll()
    .where('event_id', '=', Number(event.id)).where('deadline_version', '=', Number(event.deadline_version))
    .where('kind', '!=', 'readiness_response').forUpdate().execute();
  // A check already pending/sent belongs to this deadline. Reapplying settings
  // must neither postpone a missed check nor ask again after its answer.
  const previousCheck = existing.find((row) => row.kind === 'completion_check' && row.status !== 'cancelled');
  const checkTarget = targets.find((target) => target.kind === 'completion_check');
  if (previousCheck && checkTarget) checkTarget.at = previousCheck.remind_at_utc;
  const key = (kind: string, at: string) => `${kind}:${at}`;
  const desired = new Set(targets.map((target) => key(target.kind, target.at)));
  const cancelled = existing.filter((row) => row.status === 'pending' && !desired.has(key(row.kind, row.remind_at_utc)));
  let changes = cancelled.length;
  if (cancelled.length) await database.updateTable('notifications').set({
    status: 'cancelled', lock_token: null, locked_at: null, retry_at: null, updated_at: new Date(),
  }).where('id', 'in', cancelled.map((row) => Number(row.id))).execute();
  for (const target of targets) {
    const previous = existing.find((row) => row.kind === target.kind && row.remind_at_utc === target.at);
    if (previous && previous.status !== 'cancelled') {
      if (previous.status === 'pending' && (previous.source !== target.source || previous.timezone !== timezone)) {
        await database.updateTable('notifications').set({ source: target.source, timezone, updated_at: new Date() })
          .where('id', '=', Number(previous.id)).execute();
        changes++;
      }
      continue;
    }
    const values = {
      timezone, status: 'pending' as const, source: target.source,
      attempts: 0, lock_token: null, locked_at: null, retry_at: null, sent_at: null,
      last_error: null, updated_at: new Date(),
    };
    if (previous) {
      await database.updateTable('notifications').set(values).where('id', '=', Number(previous.id)).execute();
    } else {
      await database.insertInto('notifications').values({
        ...values, event_id: Number(event.id), deadline_version: Number(event.deadline_version),
        kind: target.kind, remind_at_utc: target.at,
      }).execute();
    }
    changes++;
  }
  const policyChanged = event.reminder_mode !== mode || Boolean(event.check_completion) !== checkCompletion;
  if (policyChanged) await database.updateTable('events').set({
    reminder_mode: mode, check_completion: Number(checkCompletion), updated_at: new Date(),
  }).where('id', '=', Number(event.id)).execute();
  return { changed: changes > 0 || policyChanged, cancelledCount: cancelled.length };
}

export const configureNotificationsInputSchema = z.object({
  eventIds: z.array(z.number().int().positive().safe()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate event IDs'),
  mode: z.enum(['default', 'custom', 'off']),
  reminderTimes: z.array(localDateTimeSchema).max(20)
    .refine((times) => new Set(times).size === times.length, 'Duplicate reminder times').nullable(),
  checkCompletion: z.boolean(),
});

export async function configureNotifications(
  database: Kysely<Database>, calendarId: number, timezone: string, now: string,
  input: z.infer<typeof configureNotificationsInputSchema>,
) {
  const parsed = configureNotificationsInputSchema.parse(input);
  if ((parsed.mode === 'custom') !== (parsed.reminderTimes !== null)) throw new Error('Provide reminderTimes only for custom mode');
  return database.transaction().execute(async (transaction) => {
    const events = await transaction.selectFrom('events').selectAll()
      .where('calendar_id', '=', calendarId).where('id', 'in', parsed.eventIds)
      .where('status', '=', 'active').orderBy('id').forUpdate().execute();
    if (events.length !== parsed.eventIds.length) throw new Error('EVENT_NOT_FOUND_OR_INACTIVE');
    let changed = false;
    for (const event of events) {
      const result = await replaceNotificationPlan(transaction, event, timezone, now,
        parsed.mode, parsed.reminderTimes ?? [], parsed.checkCompletion);
      changed ||= result.changed;
    }
    if (changed) await touchCalendarList(transaction, calendarId);
    return { success: true as const, changed, eventIds: parsed.eventIds };
  });
}
