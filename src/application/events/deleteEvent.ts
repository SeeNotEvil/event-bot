import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { cancelPendingEventNotifications } from '../notifications/cancelEventNotifications.js';
import {
  deleteEventInputSchema,
  deleteEventOutputSchema,
  type DeleteEventInput,
  type DeleteEventOutput,
} from './schemas.js';

export async function deleteEvent(
  database: Kysely<Database>,
  chatId: number,
  rawInput: DeleteEventInput,
): Promise<DeleteEventOutput> {
  const input = deleteEventInputSchema.parse(rawInput);

  return database.transaction().execute(async (transaction) => {
    const event = await transaction
      .selectFrom('events')
      .select(['id', 'title'])
      .where('id', '=', input.eventId)
      .where('chat_id', '=', chatId)
      .where('status', 'in', ['active', 'completed'])
      .forUpdate()
      .executeTakeFirst();

    if (!event) {
      return deleteEventOutputSchema.parse({
        success: false,
        event: null,
        reason: 'NOT_FOUND_OR_INACTIVE',
      });
    }

    const now = new Date();

    await transaction
      .updateTable('events')
      .set({ status: 'deleted', updated_at: now })
      .where('id', '=', input.eventId)
      .where('chat_id', '=', chatId)
      .where('status', 'in', ['active', 'completed'])
      .executeTakeFirstOrThrow();

    await cancelPendingEventNotifications(transaction, [input.eventId], now);

    return deleteEventOutputSchema.parse({
      success: true,
      event: {
        id: Number(event.id),
        title: event.title,
        status: 'deleted',
      },
    });
  });
}
