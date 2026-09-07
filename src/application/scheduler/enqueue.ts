import type { Insertable, Kysely } from 'kysely';
import type { Database, NotificationsTable } from '../../db/types.js';

/** Uses the caller's transaction so domain changes and their jobs commit together. */
export async function enqueueOnce(database: Kysely<Database>, values: Insertable<NotificationsTable>): Promise<number> {
  const result = await database.insertInto('notifications').values(values).executeTakeFirstOrThrow();
  const id = Number(result.insertId);
  if (result.insertId === undefined || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Database did not return a notification ID');
  }
  return id;
}
