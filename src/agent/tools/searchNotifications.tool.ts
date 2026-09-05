import type { Kysely } from 'kysely';
import { searchNotifications } from '../../application/notifications/searchNotifications.js';
import {
  searchNotificationsInputSchema,
  searchNotificationsOutputSchema,
} from '../../application/notifications/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createSearchNotificationsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'search_notifications',
    description:
      'Ищет актуальные напоминания текущего календаря по eventId, статусам и включительному локальному диапазону времени. Это источник notificationId для отмены и полного набора pending-напоминаний перед переносом события.',
    input: searchNotificationsInputSchema,
    output: searchNotificationsOutputSchema,
    execute: (context, input) =>
      searchNotifications(database, context.calendarId, context.timezone, input),
  });
}
