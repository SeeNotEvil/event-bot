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
      'Ищет уведомления текущего календаря по eventId, статусам и включительному локальному диапазону. kind=reminder — предварительное напоминание, completion_check — вопрос готовности; source=manual — явно заданное время, automatic — стандартное правило. Это источник notificationId для отмены и полного набора pending-уведомлений перед переносом.',
    input: searchNotificationsInputSchema,
    output: searchNotificationsOutputSchema,
    execute: (context, input) =>
      searchNotifications(database, context.calendarId, context.timezone, input),
  });
}
