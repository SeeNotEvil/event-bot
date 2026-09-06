import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { EventDto } from '../../types/domain.js';
import { createEvents } from './createEvents.js';
import type { CreateEventInput } from './schemas.js';

export async function createEvent(
  database: Kysely<Database>,
  chatId: number,
  createdByUserId: number,
  rawInput: CreateEventInput,
): Promise<EventDto> {
  const result = await createEvents(database, chatId, createdByUserId, {
    events: [rawInput],
  });
  const event = result.events[0];

  if (!event) {
    throw new Error('Single event creation returned an empty batch');
  }

  return event;
}
