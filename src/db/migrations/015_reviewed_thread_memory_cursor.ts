import { sql, type Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function up(database: Kysely<unknown>): Promise<void> {
  const db = database as Kysely<Database>;
  await db.transaction().execute(async (transaction) => {
    // append() takes the same lock, so new messages cannot appear behind this cursor.
    const thread = await transaction.selectFrom('threads').select(['id', 'summary_cursor'])
      .where('id', '=', 15).forUpdate().executeTakeFirst();
    if (!thread) return;
    const lastMessage = await transaction.selectFrom('conversation_messages').select('id')
      .where('thread_id', '=', thread.id).orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!lastMessage || Number(lastMessage.id) <= Number(thread.summary_cursor)) return;

    // The owner-reviewed summary and memories replace the accumulated backlog.
    await transaction.updateTable('threads').set({
      summary_cursor: lastMessage.id, summary_version: sql<number>`summary_version + 1`,
      lock_token: null, locked_at: null, retry_at: null, last_error: null, updated_at: new Date(),
    }).where('id', '=', thread.id).execute();
  });
}

export function down(): Promise<void> {
  throw new Error('015_reviewed_thread_memory_cursor requires a forward migration to preserve the summary cursor');
}
