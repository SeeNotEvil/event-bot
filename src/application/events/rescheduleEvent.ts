import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { mapEvent } from './mapEvent.js';
import {
  rescheduleEventInputSchema,
  rescheduleEventOutputSchema,
  type RescheduleEventFailureReason,
  type RescheduleEventInput,
  type RescheduleEventOutput,
} from './schemas.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from '../notifications/time.js';

type ReminderTarget = {
  localTime: string;
  utcTime: string;
};

function failure(reason: RescheduleEventFailureReason): RescheduleEventOutput {
  return rescheduleEventOutputSchema.parse({
    success: false,
    changed: false,
    event: null,
    notifications: [],
    cancelledNotificationCount: 0,
    reason,
  });
}

export async function rescheduleEvent(
  database: Kysely<Database>,
  userId: number,
  timezone: string,
  currentDateTime: string,
  rawInput: RescheduleEventInput,
): Promise<RescheduleEventOutput> {
  const input = rescheduleEventInputSchema.parse(rawInput);
  const now = DateTime.fromISO(currentDateTime, { setZone: true });

  if (!now.isValid) {
    return failure('INVALID_LOCAL_TIME');
  }

  const reminderTargets: ReminderTarget[] = [];
  for (const localTime of input.reminderTimes) {
    const parsed = parseLocalDateTime(localTime, timezone);
    if (!parsed) {
      return failure('INVALID_LOCAL_TIME');
    }
    if (parsed.toUTC().toMillis() <= now.toUTC().toMillis()) {
      return failure('REMINDER_NOT_IN_FUTURE');
    }

    reminderTargets.push({
      localTime,
      utcTime: formatDateForDatabase(parsed),
    });
  }

  const desiredUtcTimes = new Set(reminderTargets.map((target) => target.utcTime));

  return database.transaction().execute(async (transaction) => {
    const event = await transaction
      .selectFrom('events')
      .selectAll()
      .where('id', '=', input.eventId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .forUpdate()
      .executeTakeFirst();

    if (!event) {
      return failure('EVENT_NOT_FOUND_OR_INACTIVE');
    }

    const existingNotifications = await transaction
      .selectFrom('notifications')
      .select([
        'id',
        'event_id',
        'remind_at_utc',
        'timezone',
        'status',
      ])
      .where('event_id', '=', input.eventId)
      .forUpdate()
      .execute();
    const existingByUtcTime = new Map(
      existingNotifications.map((notification) => [
        notification.remind_at_utc,
        notification,
      ]),
    );

    const hasSentConflict = existingNotifications.some(
      (notification) =>
        notification.status === 'sent' &&
        desiredUtcTimes.has(notification.remind_at_utc),
    );
    if (hasSentConflict) {
      return failure('REMINDER_TIME_ALREADY_SENT');
    }

    const currentPending = existingNotifications.filter(
      (notification) => notification.status === 'pending',
    );
    const currentPendingUtcTimes = new Set(
      currentPending.map((notification) => notification.remind_at_utc),
    );
    const samePendingTimes =
      currentPendingUtcTimes.size === desiredUtcTimes.size &&
      [...desiredUtcTimes].every((utcTime) => currentPendingUtcTimes.has(utcTime));
    const samePendingTimezones = reminderTargets.every((target) => {
      const notification = existingByUtcTime.get(target.utcTime);
      return notification?.status === 'pending' && notification.timezone === timezone;
    });
    const sameSchedule =
      event.date_from === input.dateFrom &&
      event.date_to === input.dateTo &&
      (event.time === null ? null : event.time.slice(0, 5)) === input.time;
    const changed = !sameSchedule || !samePendingTimes || !samePendingTimezones;

    const cancelledIds = currentPending
      .filter((notification) => !desiredUtcTimes.has(notification.remind_at_utc))
      .map((notification) => Number(notification.id));
    const updatedAt = new Date();

    if (!sameSchedule) {
      const update = await transaction
        .updateTable('events')
        .set({
          date_from: input.dateFrom,
          date_to: input.dateTo,
          time: input.time,
          updated_at: updatedAt,
        })
        .where('id', '=', input.eventId)
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();

      if (Number(update.numUpdatedRows) !== 1) {
        throw new Error('Event reschedule updated an unexpected number of rows');
      }
    }

    if (cancelledIds.length > 0) {
      const cancellation = await transaction
        .updateTable('notifications')
        .set({
          status: 'cancelled',
          lock_token: null,
          locked_at: null,
          last_error: null,
          updated_at: updatedAt,
        })
        .where('id', 'in', cancelledIds)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();

      if (Number(cancellation.numUpdatedRows) !== cancelledIds.length) {
        throw new Error('Reminder replacement cancelled an unexpected number of rows');
      }
    }

    for (const target of reminderTargets) {
      const existing = existingByUtcTime.get(target.utcTime);

      if (existing?.status === 'pending') {
        if (existing.timezone !== timezone) {
          await transaction
            .updateTable('notifications')
            .set({ timezone, updated_at: updatedAt })
            .where('id', '=', Number(existing.id))
            .where('status', '=', 'pending')
            .executeTakeFirstOrThrow();
        }
        continue;
      }

      if (existing?.status === 'cancelled') {
        await transaction
          .updateTable('notifications')
          .set({
            timezone,
            status: 'pending',
            attempts: 0,
            lock_token: null,
            locked_at: null,
            sent_at: null,
            last_error: null,
            updated_at: updatedAt,
          })
          .where('id', '=', Number(existing.id))
          .where('status', '=', 'cancelled')
          .executeTakeFirstOrThrow();
        continue;
      }

      await transaction
        .insertInto('notifications')
        .values({
          event_id: input.eventId,
          remind_at_utc: target.utcTime,
          timezone,
          status: 'pending',
          lock_token: null,
          locked_at: null,
          sent_at: null,
          last_error: null,
          updated_at: updatedAt,
        })
        .executeTakeFirstOrThrow();
    }

    const updatedEvent = sameSchedule
      ? event
      : await transaction
          .selectFrom('events')
          .selectAll()
          .where('id', '=', input.eventId)
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow();
    const pendingNotifications = await transaction
      .selectFrom('notifications')
      .select(['id', 'event_id', 'remind_at_utc', 'timezone', 'status'])
      .where('event_id', '=', input.eventId)
      .where('status', '=', 'pending')
      .orderBy('remind_at_utc', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return rescheduleEventOutputSchema.parse({
      success: true,
      changed,
      event: mapEvent(updatedEvent),
      notifications: pendingNotifications.map((notification) => ({
        id: Number(notification.id),
        eventId: Number(notification.event_id),
        eventTitle: updatedEvent.title,
        remindAt: formatUtcDateTimeInZone(
          notification.remind_at_utc,
          notification.timezone,
        ),
        timezone: notification.timezone,
        status: notification.status,
      })),
      cancelledNotificationCount: cancelledIds.length,
    });
  });
}
