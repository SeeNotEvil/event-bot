import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import {
  deleteNotificationInputSchema,
  deleteNotificationOutputSchema,
  type DeleteNotificationInput,
  type DeleteNotificationOutput,
} from './schemas.js';
import { formatUtcDateTimeInZone } from './time.js';

export async function deleteNotification(
  database: Kysely<Database>,
  calendarId: number,
  rawInput: DeleteNotificationInput,
): Promise<DeleteNotificationOutput> {
  const input = deleteNotificationInputSchema.parse(rawInput);

  return database.transaction().execute(async (transaction) => {
    const notification = await transaction
      .selectFrom('notifications')
      .innerJoin('events', 'events.id', 'notifications.event_id')
      .select([
        'notifications.id as notification_id',
        'notifications.event_id',
        'notifications.remind_at_utc',
        'notifications.timezone',
        'events.title as event_title',
      ])
      .where('notifications.id', '=', input.notificationId)
      .where('events.calendar_id', '=', calendarId)
      .where('notifications.status', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();

    if (!notification) {
      return deleteNotificationOutputSchema.parse({
        success: false,
        notification: null,
        reason: 'NOT_FOUND_OR_NOT_PENDING',
      });
    }

    await transaction
      .updateTable('notifications')
      .set({
        status: 'cancelled',
        lock_token: null,
        locked_at: null,
        last_error: null,
        updated_at: new Date(),
      })
      .where('id', '=', input.notificationId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    return deleteNotificationOutputSchema.parse({
      success: true,
      notification: {
        id: Number(notification.notification_id),
        eventId: Number(notification.event_id),
        eventTitle: notification.event_title,
        remindAt: formatUtcDateTimeInZone(
          notification.remind_at_utc,
          notification.timezone,
        ),
        timezone: notification.timezone,
        status: 'cancelled',
      },
    });
  });
}
