import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import {
  createNotificationInputSchema,
  createNotificationOutputSchema,
  type CreateNotificationInput,
  type CreateNotificationOutput,
} from './schemas.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from './time.js';

export async function createNotification(
  database: Kysely<Database>,
  chatId: number,
  timezone: string,
  currentDateTime: string,
  rawInput: CreateNotificationInput,
): Promise<CreateNotificationOutput> {
  const input = createNotificationInputSchema.parse(rawInput);
  const remindAt = parseLocalDateTime(input.remindAt, timezone);
  const now = DateTime.fromISO(currentDateTime, { setZone: true });

  if (!remindAt || !now.isValid) {
    return createNotificationOutputSchema.parse({
      success: false,
      created: false,
      notification: null,
      reason: 'INVALID_LOCAL_TIME',
    });
  }

  if (remindAt.toUTC().toMillis() <= now.toUTC().toMillis()) {
    return createNotificationOutputSchema.parse({
      success: false,
      created: false,
      notification: null,
      reason: 'REMINDER_NOT_IN_FUTURE',
    });
  }

  const remindAtUtc = formatDateForDatabase(remindAt);

  return database.transaction().execute(async (transaction) => {
    const event = await transaction
      .selectFrom('events')
      .select(['id', 'title', 'deadline_version'])
      .where('id', '=', input.eventId)
      .where('chat_id', '=', chatId)
      .where('status', '=', 'active')
      .forUpdate()
      .executeTakeFirst();

    if (!event) {
      return createNotificationOutputSchema.parse({
        success: false,
        created: false,
        notification: null,
        reason: 'EVENT_NOT_FOUND_OR_INACTIVE',
      });
    }

    const existing = await transaction
      .selectFrom('notifications')
      .select(['id', 'event_id', 'remind_at_utc', 'timezone', 'status', 'source'])
      .where('event_id', '=', input.eventId)
      .where('kind', '=', 'reminder')
      .where('deadline_version', '=', Number(event.deadline_version))
      .where('remind_at_utc', '=', remindAtUtc)
      .forUpdate()
      .executeTakeFirst();

    if (existing) {
      const shouldReactivate = existing.status === 'cancelled';

      if (shouldReactivate) {
        await transaction
          .updateTable('notifications')
          .set({
            timezone,
            source: 'manual',
            status: 'pending',
            attempts: 0,
            lock_token: null,
            locked_at: null,
            retry_at: null,
            sent_at: null,
            last_error: null,
            updated_at: new Date(),
          })
          .where('id', '=', Number(existing.id))
          .executeTakeFirstOrThrow();
      } else if (existing.status === 'pending' && existing.source !== 'manual') {
        await transaction.updateTable('notifications').set({ source: 'manual', updated_at: new Date() })
          .where('id', '=', Number(existing.id)).execute();
      }

      return createNotificationOutputSchema.parse({
        success: true,
        created: shouldReactivate,
        notification: {
          id: Number(existing.id),
          eventId: Number(existing.event_id),
          eventTitle: event.title,
          remindAt: formatUtcDateTimeInZone(existing.remind_at_utc, timezone),
          timezone,
          status: shouldReactivate ? 'pending' : existing.status,
          kind: 'reminder',
          source: existing.status === 'sent' ? existing.source : 'manual',
        },
      });
    }

    const insertion = await transaction
      .insertInto('notifications')
      .values({
        event_id: input.eventId,
        deadline_version: Number(event.deadline_version),
        remind_at_utc: remindAtUtc,
        timezone,
        status: 'pending',
        kind: 'reminder',
        source: 'manual',
        lock_token: null,
        locked_at: null,
        sent_at: null,
        last_error: null,
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();

    if (insertion.insertId === undefined) {
      throw new Error('Database did not return a notification id');
    }

    const notificationId = Number(insertion.insertId);
    if (!Number.isSafeInteger(notificationId)) {
      throw new Error('Notification id exceeds JavaScript safe integer range');
    }

    return createNotificationOutputSchema.parse({
      success: true,
      created: true,
      notification: {
        id: notificationId,
        eventId: Number(event.id),
        eventTitle: event.title,
        remindAt: input.remindAt,
        timezone,
        status: 'pending',
        kind: 'reminder',
        source: 'manual',
      },
    });
  });
}
