import type { Kysely } from 'kysely';
import { deleteEvent } from '../../application/events/deleteEvent.js';
import {
  deleteEventInputSchema,
  deleteEventOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createDeleteEventTool(database: Kysely<Database>) {
  return defineTool({
    name: 'delete_event',
    requiresUser: true,
    description:
      'Мягко удаляет одно однозначно выбранное active- или completed-событие текущего календаря и отменяет его pending-напоминания. eventId должен происходить из свежего search_events. В составном поручении до удаления должны быть определены обязательные данные для всех его частей: если при замене расписания неизвестна дата нового события, сначала уточни её и ничего не удаляй. Если событие уже недоступно, success=false и состояние не меняется. После успеха продолжи остальные действия поручения, затем отправь общий итог.',
    input: deleteEventInputSchema,
    output: deleteEventOutputSchema,
    execute: (context, input) => deleteEvent(database, context.calendarId, input),
  });
}
