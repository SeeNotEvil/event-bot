import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { mapEvent } from '../events/mapEvent.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from '../notifications/time.js';
import {
  searchScheduleInputSchema,
  searchScheduleOutputSchema,
  type SearchScheduleInput,
  type SearchScheduleOutput,
} from './schemas.js';

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export async function searchSchedule(
  database: Kysely<Database>,
  calendarId: number,
  timezone: string,
  rawInput: SearchScheduleInput,
): Promise<SearchScheduleOutput> {
  const input = searchScheduleInputSchema.parse(rawInput);
  const eventStatuses = input.eventStatuses ?? ['active'];
  const reminderStatuses = input.reminderStatuses ?? ['pending'];
  const reminderFrom = input.reminderFrom
    ? parseLocalDateTime(input.reminderFrom, timezone)
    : null;
  const reminderTo = input.reminderTo
    ? parseLocalDateTime(input.reminderTo, timezone)
    : null;

  if ((input.reminderFrom && !reminderFrom) || (input.reminderTo && !reminderTo)) {
    throw new Error('Schedule search contains an invalid local reminder time');
  }

  const reminderFromUtc = reminderFrom ? formatDateForDatabase(reminderFrom) : null;
  const reminderToUtc = reminderTo ? formatDateForDatabase(reminderTo) : null;
  let eventsQuery = database
    .selectFrom('events')
    .innerJoin('users as event_creator', 'event_creator.id', 'events.user_id')
    .selectAll('events')
    .select('event_creator.first_name as creator_first_name')
    .where('events.calendar_id', '=', calendarId)
    .where('events.status', 'in', eventStatuses);

  if (input.query !== null) {
    const pattern = `%${escapeLikePattern(input.query)}%`;
    eventsQuery = eventsQuery.where((expression) =>
      expression.or([
        expression('events.title', 'like', pattern),
        expression('events.description', 'like', pattern),
      ]),
    );
  }
  if (input.eventDateFrom !== null) {
    eventsQuery = eventsQuery.where(
      sql<boolean>`coalesce(${sql.ref('events.date_to')}, ${sql.ref('events.date_from')}) >= ${input.eventDateFrom}`,
    );
  }
  if (input.eventDateTo !== null) {
    eventsQuery = eventsQuery.where('events.date_from', '<=', input.eventDateTo);
  }
  if (input.requireReminder) {
    eventsQuery = eventsQuery.where((expression) => {
      let matchingNotifications = expression
        .selectFrom('notifications')
        .select('notifications.id')
        .whereRef('notifications.event_id', '=', 'events.id')
        .where('notifications.kind', '!=', 'readiness_response')
        .where('notifications.status', 'in', reminderStatuses);

      if (reminderFromUtc !== null) {
        matchingNotifications = matchingNotifications.where(
          'notifications.remind_at_utc',
          '>=',
          reminderFromUtc,
        );
      }
      if (reminderToUtc !== null) {
        matchingNotifications = matchingNotifications.where(
          'notifications.remind_at_utc',
          '<=',
          reminderToUtc,
        );
      }

      return expression.exists(matchingNotifications);
    });
  }

  const eventRows = await eventsQuery
    .orderBy(sql`events.date_from is null`, 'asc')
    .orderBy(sql`coalesce(events.date_to, events.date_from)`, 'asc')
    .orderBy('events.time', 'asc')
    .orderBy('events.id', 'asc')
    .limit(input.limit ?? 50)
    .execute();

  if (eventRows.length === 0) {
    return searchScheduleOutputSchema.parse({ events: [] });
  }

  const eventIds = eventRows.map((event) => Number(event.id));
  let notificationsQuery = database
    .selectFrom('notifications')
    .innerJoin('events', 'events.id', 'notifications.event_id')
    .select([
      'notifications.id as notification_id',
      'notifications.event_id',
      'notifications.remind_at_utc',
      'notifications.status',
      'notifications.kind',
      'notifications.source',
      'events.title as event_title',
    ])
    .where('events.calendar_id', '=', calendarId)
    .where('notifications.kind', '!=', 'readiness_response')
    .where('notifications.event_id', 'in', eventIds)
    .where('notifications.status', 'in', reminderStatuses);

  if (reminderFromUtc !== null) {
    notificationsQuery = notificationsQuery.where(
      'notifications.remind_at_utc',
      '>=',
      reminderFromUtc,
    );
  }
  if (reminderToUtc !== null) {
    notificationsQuery = notificationsQuery.where(
      'notifications.remind_at_utc',
      '<=',
      reminderToUtc,
    );
  }

  const notificationRows = await notificationsQuery
    .orderBy('notifications.remind_at_utc', 'asc')
    .orderBy('notifications.id', 'asc')
    .execute();
  const notificationsByEventId = new Map<number, SearchScheduleOutput['events'][number]['notifications']>();

  for (const notification of notificationRows) {
    const eventId = Number(notification.event_id);
    const notifications = notificationsByEventId.get(eventId) ?? [];
    notifications.push({
      id: Number(notification.notification_id),
      eventId,
      eventTitle: notification.event_title,
      remindAt: formatUtcDateTimeInZone(notification.remind_at_utc, timezone),
      timezone,
      status: notification.status,
      kind: notification.kind as 'reminder' | 'completion_check',
      source: notification.source,
    });
    notificationsByEventId.set(eventId, notifications);
  }

  return searchScheduleOutputSchema.parse({
    events: eventRows.map((event) => ({
      ...mapEvent(event),
      createdByName: event.creator_first_name ?? 'Пользователь',
      notifications: notificationsByEventId.get(Number(event.id)) ?? [],
    })),
  });
}
