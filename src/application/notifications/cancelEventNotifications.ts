import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export async function cancelPendingEventNotifications(
  database: Kysely<Database>,
  eventIds: number[],
  now: Date,
): Promise<number> {
  if (eventIds.length === 0) {
    return 0;
  }

  const result = await database
    .updateTable('notifications')
    .set({
      status: 'cancelled',
      lock_token: null,
      locked_at: null,
      last_error: null,
      updated_at: now,
    })
    .where('event_id', 'in', eventIds)
    .where('status', '=', 'pending')
    .executeTakeFirstOrThrow();

  return Number(result.numUpdatedRows);
}
