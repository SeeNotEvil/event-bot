import type { Kysely } from 'kysely';
import { deleteNotification } from '../../application/notifications/deleteNotification.js';
import {
  deleteNotificationInputSchema,
  deleteNotificationOutputSchema,
} from '../../application/notifications/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createDeleteNotificationTool(database: Kysely<Database>) {
  return defineTool({
    name: 'delete_notification',
    description:
      'Мягко отменяет одно однозначно выбранное pending-напоминание текущего пользователя. notificationId должен происходить из свежего search_notifications; при нескольких подходящих вариантах сначала требуется уточнение. Sent-напоминание отменить нельзя.',
    input: deleteNotificationInputSchema,
    output: deleteNotificationOutputSchema,
    execute: (context, input) => deleteNotification(database, context.userId, input),
  });
}
