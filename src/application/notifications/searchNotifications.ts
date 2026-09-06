import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import {
  searchNotificationsInputSchema,
  searchNotificationsOutputSchema,
  type SearchNotificationsInput,
  type SearchNotificationsOutput,
} from './schemas.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from './time.js';

export async function searchNotifications(
  database: Kysely<Database>,
  chatId: number,
  timezone: string,
  rawInput: SearchNotificationsInput,
): Promise<SearchNotificationsOutput> {
  const input = searchNotificationsInputSchema.parse(rawInput);
  const remindFrom = input.remindFrom
    ? parseLocalDateTime(input.remindFrom, timezone)
    : null;
  const remindTo = input.remindTo
    ? parseLocalDateTime(input.remindTo, timezone)
    : null;

  if ((input.remindFrom && !remindFrom) || (input.remindTo && !remindTo)) {
    throw new Error('Reminder search contains an invalid local time');
  }

  let query = database
    .selectFrom('notifications')
    .innerJoin('events', 'events.id', 'notifications.event_id')
    .select([
      'notifications.id as notification_id',
      'notifications.event_id',
      'notifications.remind_at_utc',
      'notifications.timezone',
      'notifications.status',
      'notifications.kind',
      'notifications.source',
      'events.title as event_title',
    ])
    .where('events.chat_id', '=', chatId)
    .where('notifications.kind', '!=', 'readiness_response')
    .where('notifications.status', 'in', input.statuses ?? ['pending']);

  if (input.eventId !== null) {
    query = query.where('notifications.event_id', '=', input.eventId);
  }
  if (remindFrom) {
    query = query.where(
      'notifications.remind_at_utc',
      '>=',
      formatDateForDatabase(remindFrom),
    );
  }
  if (remindTo) {
    query = query.where(
      'notifications.remind_at_utc',
      '<=',
      formatDateForDatabase(remindTo),
    );
  }

  const rows = await query
    .orderBy('notifications.remind_at_utc', 'asc')
    .orderBy('notifications.id', 'asc')
    .limit(input.limit ?? 50)
    .execute();

  return searchNotificationsOutputSchema.parse({
    notifications: rows.map((row) => ({
      id: Number(row.notification_id),
      eventId: Number(row.event_id),
      eventTitle: row.event_title,
      remindAt: formatUtcDateTimeInZone(row.remind_at_utc, row.timezone),
      timezone: row.timezone,
      status: row.status,
      kind: row.kind,
      source: row.source,
    })),
  });
}
