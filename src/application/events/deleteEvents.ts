import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { cancelPendingEventNotifications } from '../notifications/cancelEventNotifications.js';
import {
  deleteEventsInputSchema,
  deleteEventsOutputSchema,
  type DeleteEventsInput,
  type DeleteEventsOutput,
} from './schemas.js';

export async function deleteEvents(
  database: Kysely<Database>,
  userId: number,
  rawInput: DeleteEventsInput,
): Promise<DeleteEventsOutput> {
  const input = deleteEventsInputSchema.parse(rawInput);

  return database.transaction().execute(async (transaction) => {
    const rows = await transaction
      .selectFrom('events')
      .select(['id', 'title'])
      .where('id', 'in', input.eventIds)
      .where('user_id', '=', userId)
      .where('status', 'in', ['active', 'completed'])
      .forUpdate()
      .execute();

    const rowsById = new Map(rows.map((row) => [Number(row.id), row]));
    const missingEventIds = input.eventIds.filter((eventId) => !rowsById.has(eventId));

    if (missingEventIds.length > 0) {
      return deleteEventsOutputSchema.parse({
        success: false,
        deletedCount: 0,
        events: [],
        reason: 'NOT_FOUND_OR_INACTIVE',
        missingEventIds,
      });
    }

    const now = new Date();
    const update = await transaction
      .updateTable('events')
      .set({ status: 'deleted', updated_at: now })
      .where('id', 'in', input.eventIds)
      .where('user_id', '=', userId)
      .where('status', 'in', ['active', 'completed'])
      .executeTakeFirstOrThrow();

    if (Number(update.numUpdatedRows) !== input.eventIds.length) {
      throw new Error('Bulk event deletion updated an unexpected number of rows');
    }

    await cancelPendingEventNotifications(transaction, input.eventIds, now);

    return deleteEventsOutputSchema.parse({
      success: true,
      deletedCount: input.eventIds.length,
      events: input.eventIds.map((eventId) => {
        const row = rowsById.get(eventId);
        if (!row) {
          throw new Error('Locked event disappeared during bulk deletion');
        }

        return {
          id: eventId,
          title: row.title,
          status: 'deleted',
        };
      }),
    });
  });
}
