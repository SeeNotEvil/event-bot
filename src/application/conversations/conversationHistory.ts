import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { ConversationMessage } from '../../types/domain.js';

const messageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(65_535) });
export type MessageMetadata = { messageId?: number | undefined; replyToMessageId?: number | undefined; authorName?: string | undefined };

export async function readChatMessages(database: Kysely<Database>, calendarId: number, limit: number, excludeMessageId?: number) {
  let query = database.selectFrom('conversation_messages')
    .select(['role', 'content', 'author_name', 'telegram_message_id', 'reply_to_message_id', 'created_at'])
    .where('calendar_id', '=', calendarId);
  if (excludeMessageId !== undefined) query = query.where((eb) => eb.or([
    eb('telegram_message_id', 'is', null), eb('telegram_message_id', '!=', excludeMessageId),
  ]));
  return (await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute()).reverse()
    .map((row) => ({ role: row.role, content: row.content, author: row.author_name,
      messageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
      replyToMessageId: row.reply_to_message_id === null ? null : Number(row.reply_to_message_id), createdAt: row.created_at }));
}

export async function getRecentMessages(database: Kysely<Database>, calendarId: number, limit: number, excludeMessageId?: number): Promise<ConversationMessage[]> {
  return (await readChatMessages(database, calendarId, limit, excludeMessageId)).map((row) => ({
    role: row.role, content: row.role === 'user' && row.author ? `${row.author}: ${row.content}` : row.content,
  }));
}

export async function appendMessage(
  database: Kysely<Database>, calendarId: number, userId: number | null,
  rawMessage: ConversationMessage, historyLimit: number, metadata: MessageMetadata = {},
): Promise<boolean> {
  const message = messageSchema.parse(rawMessage);
  return database.transaction().execute(async (transaction) => {
    let insertion = transaction.insertInto('conversation_messages').values({
      user_id: userId, calendar_id: calendarId, role: message.role, content: message.content,
      telegram_message_id: metadata.messageId ?? null,
      reply_to_message_id: metadata.replyToMessageId ?? null, author_name: metadata.authorName ?? null,
    });
    if (message.role === 'assistant') insertion = insertion.onDuplicateKeyUpdate({ content: message.content });
    else insertion = insertion.ignore();
    const result = await insertion.executeTakeFirstOrThrow();
    const staleRows = await transaction.selectFrom('conversation_messages').select('id')
      .where('calendar_id', '=', calendarId).orderBy('created_at', 'desc').orderBy('id', 'desc')
      .limit(10_000).offset(historyLimit).execute();
    if (staleRows.length) await transaction.deleteFrom('conversation_messages')
      .where('id', 'in', staleRows.map((row) => Number(row.id))).execute();
    return Number(result.numInsertedOrUpdatedRows) > 0;
  });
}
