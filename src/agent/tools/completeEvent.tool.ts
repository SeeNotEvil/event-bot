import type { Kysely } from 'kysely';
import { completeEvent } from '../../application/events/completeEvent.js';
import {
  completeEventInputSchema,
  completeEventOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createCompleteEventTool(database: Kysely<Database>) {
  return defineTool({
    name: 'complete_event',
    description:
      'Помечает одно однозначно выбранное active-событие текущего календаря выполненным и отменяет его pending-напоминания. При повторном вызове для completed-события возвращает changed=false. eventId должен происходить из свежего search_events со статусами, подходящими запросу пользователя.',
    input: completeEventInputSchema,
    output: completeEventOutputSchema,
    execute: (context, input) => completeEvent(database, context.calendarId, input),
  });
}
