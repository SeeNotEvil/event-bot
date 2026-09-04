import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { ConversationMessage } from '../../types/domain.js';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(65_535),
});

export async function getRecentMessages(
  database: Kysely<Database>,
  userId: number,
  limit: number,
): Promise<ConversationMessage[]> {
  const rows = await database
    .selectFrom('conversation_messages')
    .select(['role', 'content'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();

  return rows.reverse().map((row) => messageSchema.parse(row));
}

export async function appendMessage(
  database: Kysely<Database>,
  userId: number,
  rawMessage: ConversationMessage,
  historyLimit: number,
): Promise<void> {
  const message = messageSchema.parse(rawMessage);

  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('conversation_messages')
      .values({
        user_id: userId,
        role: message.role,
        content: message.content,
      })
      .execute();

    const staleRows = await transaction
      .selectFrom('conversation_messages')
      .select('id')
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(10_000)
      .offset(historyLimit)
      .execute();

    if (staleRows.length > 0) {
      await transaction
        .deleteFrom('conversation_messages')
        .where(
          'id',
          'in',
          staleRows.map((row) => Number(row.id)),
        )
        .execute();
    }
  });
}
