import type { Kysely } from 'kysely';
import { searchEvents } from '../../application/events/searchEvents.js';
import {
  searchEventsInputSchema,
  searchEventsOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createSearchEventsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'search_events',
    description:
      'Ищет актуальные события текущего календаря по тексту, статусам и пересечению включительного диапазона дат; ближайшие возвращаются первыми. В группе поиск охватывает общий календарь группы, а не личный календарь говорящего. Это источник eventId для изменения, завершения, переноса, удаления и работы с напоминаниями. Используй statuses, соответствующие запросу: обычно active; completed добавляй только когда пользователь имеет в виду выполненные.',
    input: searchEventsInputSchema,
    output: searchEventsOutputSchema,
    execute: (context, input) => searchEvents(database, context.chatId, input),
  });
}
