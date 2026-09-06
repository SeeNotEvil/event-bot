import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { mapEvent } from './mapEvent.js';
import { rescheduleEventInputSchema, rescheduleEventOutputSchema,
  rescheduleEventFailureReasonSchema, type RescheduleEventInput, type RescheduleEventOutput,
  type RescheduleEventFailureReason } from './schemas.js';
import { formatUtcDateTimeInZone } from '../notifications/time.js';
import { planNotifications, replaceNotificationPlan, type ReminderMode } from '../notifications/configureNotifications.js';
import { cancelPendingEventNotifications } from '../notifications/cancelEventNotifications.js';
import { touchChatList } from '../schedule/chatList.js';

function failure(reason: RescheduleEventFailureReason): RescheduleEventOutput {
  return { success: false, changed: false, event: null, notifications: [], cancelledNotificationCount: 0, reason };
}

export async function rescheduleEvent(
  database: Kysely<Database>, chatId: number, timezone: string, now: string, rawInput: RescheduleEventInput,
): Promise<RescheduleEventOutput> {
  const input = rescheduleEventInputSchema.parse(rawInput);
  try {
    return await database.transaction().execute(async (transaction) => {
      const event = await transaction.selectFrom('events').selectAll()
        .where('id', '=', input.eventId).where('chat_id', '=', chatId)
        .where('status', '=', 'active').forUpdate().executeTakeFirst();
      if (!event) return failure('EVENT_NOT_FOUND_OR_INACTIVE');
      const pending = await transaction.selectFrom('notifications').selectAll()
        .where('event_id', '=', input.eventId).where('status', '=', 'pending').forUpdate().execute();
      if (input.reminderTimes === null && pending.some((row) => row.kind === 'reminder' && row.source === 'manual')) {
        return failure('CUSTOM_REMINDER_TIMES_REQUIRED');
      }
      const mode: ReminderMode = input.reminderTimes === null
        ? event.reminder_mode === 'legacy' ? 'default' : event.reminder_mode
        : input.reminderTimes.length ? 'custom' : 'off';
      const checkCompletion = event.reminder_mode === 'legacy' ? true : Boolean(event.check_completion);
      const targets = planNotifications(input, timezone, now, mode, input.reminderTimes ?? [], checkCompletion);
      const customTimes = targets.filter((target) => target.source === 'manual').map((target) => target.at);
      if (customTimes.length) {
        const sent = await transaction.selectFrom('notifications').select('id')
          .where('event_id', '=', input.eventId).where('kind', '=', 'reminder')
          .where('status', '=', 'sent').where('remind_at_utc', 'in', customTimes).executeTakeFirst();
        if (sent) return failure('REMINDER_TIME_ALREADY_SENT');
      }
      const scheduleChanged = event.date_from !== input.dateFrom || event.date_to !== input.dateTo ||
        (event.time === null ? null : event.time.slice(0, 5)) !== input.time;
      let cancelledCount = 0;
      const updatedEvent = { ...event, date_from: input.dateFrom, date_to: input.dateTo, time: input.time,
        deadline_version: Number(event.deadline_version) + Number(scheduleChanged) };
      if (scheduleChanged) {
        cancelledCount = await cancelPendingEventNotifications(transaction, [input.eventId], new Date());
        await transaction.updateTable('events').set({
          date_from: input.dateFrom, date_to: input.dateTo, time: input.time,
          deadline_version: updatedEvent.deadline_version, updated_at: new Date(),
        }).where('id', '=', input.eventId).execute();
      }
      const plan = await replaceNotificationPlan(transaction, updatedEvent, timezone, now,
        mode, input.reminderTimes ?? [], checkCompletion);
      const changed = scheduleChanged || plan.changed;
      if (changed) await touchChatList(transaction, chatId);
      const notifications = await transaction.selectFrom('notifications').selectAll()
        .where('event_id', '=', input.eventId).where('status', '=', 'pending')
        .where('kind', '!=', 'readiness_response').orderBy('remind_at_utc').orderBy('id').execute();
      return rescheduleEventOutputSchema.parse({
        success: true, changed,
        event: mapEvent({ ...updatedEvent, reminder_mode: mode, check_completion: Number(checkCompletion) }),
        cancelledNotificationCount: cancelledCount + plan.cancelledCount,
        notifications: notifications.map((row) => ({
          id: Number(row.id), eventId: input.eventId, eventTitle: event.title,
          remindAt: formatUtcDateTimeInZone(row.remind_at_utc, timezone), timezone, status: row.status,
          kind: row.kind, source: row.source,
        })),
      });
    });
  } catch (error) {
    const reason = rescheduleEventFailureReasonSchema.safeParse(error instanceof Error ? error.message : null);
    if (reason.success) return failure(reason.data);
    throw error;
  }
}
