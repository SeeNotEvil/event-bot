import type { Kysely } from 'kysely';
import { createEvents } from '../../application/events/createEvents.js';
import {
  createEventsInputSchema,
  createEventsOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export const createEventsToolDescription =
  'Атомарно создаёт весь набор из 1–100 задач текущего чата. Передай все задачи одним вызовом. Дата может отсутствовать: dateFrom/dateTo/time=null. Неоднозначные даты и точные дубликаты требуют уточнения до изменений. После успеха сама вызови configure_notifications для созданных ID: default/checkCompletion=true, если пользователь не задал свои настройки. Затем выполни оставшиеся части запроса и сообщи общий итог.';

export function createCreateEventsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'create_events',
    requiresUser: true,
    description: createEventsToolDescription,
    input: createEventsInputSchema,
    output: createEventsOutputSchema,
    execute: (context, input) => {
      if (context.userId === null) throw new Error('Creating tasks requires a user request');
      return createEvents(database, context.chatId, context.userId, input);
    },
  });
}
