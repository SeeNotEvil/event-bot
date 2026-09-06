import type { Kysely } from 'kysely';
import { deleteEvents } from '../../application/events/deleteEvents.js';
import {
  deleteEventsInputSchema,
  deleteEventsOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createDeleteEventsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'delete_events',
    requiresUser: true,
    description:
      'Транзакционно и мягко удаляет явно выбранную группу из 2–100 active- или completed-событий текущего календаря и отменяет их pending-напоминания. Передавай весь набор уникальных id только из одного свежего search_events и не расширяй условия пользователя. В составном поручении до удаления должны быть определены обязательные данные для всех его частей: если при замене расписания неизвестна дата нового события, сначала уточни её и ничего не удаляй. Если хотя бы один id недоступен, не удаляется ничего. После успеха продолжи остальные действия поручения, затем отправь общий итог.',
    input: deleteEventsInputSchema,
    output: deleteEventsOutputSchema,
    execute: (context, input) => deleteEvents(database, context.calendarId, input),
  });
}
