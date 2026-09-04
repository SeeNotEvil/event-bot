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
    description:
      'Мягко удаляет одно однозначно выбранное active- или completed-событие текущего пользователя и отменяет его pending-напоминания. eventId должен происходить из свежего search_events. Если событие уже недоступно, success=false и состояние не меняется.',
    input: deleteEventInputSchema,
    output: deleteEventOutputSchema,
    execute: (context, input) => deleteEvent(database, context.userId, input),
  });
}
