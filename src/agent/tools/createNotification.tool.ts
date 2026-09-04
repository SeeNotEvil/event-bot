import type { Kysely } from 'kysely';
import { createNotification } from '../../application/notifications/createNotification.js';
import {
  createNotificationInputSchema,
  createNotificationOutputSchema,
} from '../../application/notifications/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createCreateNotificationTool(database: Kysely<Database>) {
  return defineTool({
    name: 'create_notification',
    description:
      'Создаёт одно напоминание для active-события текущего пользователя. eventId бери из результата create_events в этом запуске либо из свежего search_events. remindAt — однозначные локальные дата и время YYYY-MM-DDTHH:mm; timezone и текущее время берутся из защищённого контекста. Для явно запрошенных разных моментов можно вызвать tool несколько раз; одинаковое напоминание повторно не создаётся.',
    input: createNotificationInputSchema,
    output: createNotificationOutputSchema,
    execute: (context, input) =>
      createNotification(database, context.userId, context.timezone, context.now, input),
  });
}
