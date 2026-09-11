import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { ConversationMessage } from '../../types/domain.js';
import type { ArchivedMessage, MessageMetadata, SummaryBatch, ThreadMemory } from './ThreadMemory.js';

const messageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(65_535) });
export const SUMMARY_BATCH_SIZE = 10;
export const summarySchema = z.string().trim().min(1).max(4_000);

function mapMessage(row: {
  id: number; role: 'user' | 'assistant'; content: string; author_name: string | null;
  telegram_message_id: number | null; reply_to_message_id: number | null; created_at: string;
}): ArchivedMessage {
  return { id: Number(row.id), role: row.role, content: row.content, author: row.author_name,
    messageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
    replyToMessageId: row.reply_to_message_id === null ? null : Number(row.reply_to_message_id), createdAt: row.created_at };
}

export class MysqlThreadMemory implements ThreadMemory {
  public constructor(private readonly database: Kysely<Database>) {}

  public async ensure(chatId: number) {
    await this.database.insertInto('threads').values({ chat_id: chatId })
      .onDuplicateKeyUpdate({ chat_id: chatId }).execute();
    const row = await this.database.selectFrom('threads').selectAll().where('chat_id', '=', chatId).executeTakeFirstOrThrow();
    return { id: Number(row.id), summary: row.summary, summaryCursor: Number(row.summary_cursor), summaryVersion: Number(row.summary_version) };
  }

  public async append(threadId: number, userId: number | null, rawMessage: ConversationMessage, metadata: MessageMetadata = {}) {
    const message = messageSchema.parse(rawMessage);
    return this.database.transaction().execute(async (transaction) => {
      // Serialize inserts in a thread so a later commit cannot appear behind the summary cursor.
      await transaction.selectFrom('threads').select('id').where('id', '=', threadId).forUpdate().executeTakeFirstOrThrow();
      let insertion = transaction.insertInto('conversation_messages').values({
        user_id: userId, thread_id: threadId, role: message.role, content: message.content,
        telegram_message_id: metadata.messageId ?? null,
        reply_to_message_id: metadata.replyToMessageId ?? null, author_name: metadata.authorName ?? null,
      });
      if (message.role === 'assistant') insertion = insertion.onDuplicateKeyUpdate({ content: message.content });
      else insertion = insertion.ignore();
      return Number((await insertion.executeTakeFirstOrThrow()).numInsertedOrUpdatedRows) > 0;
    });
  }

  public async read(threadId: number, limit: number, beforeId?: number, excludeMessageId?: number) {
    let query = this.database.selectFrom('conversation_messages').selectAll().where('thread_id', '=', threadId);
    if (beforeId !== undefined) query = query.where('id', '<', beforeId);
    if (excludeMessageId !== undefined) query = query.where((eb) => eb.or([
      eb('telegram_message_id', 'is', null), eb('telegram_message_id', '!=', excludeMessageId),
    ]));
    return (await query.orderBy('id', 'desc').limit(limit).execute()).reverse().map(mapMessage);
  }

  public async claimSummary(recentLimit: number, leaseMs: number): Promise<SummaryBatch | null> {
    return this.database.transaction().execute(async (transaction) => {
      const now = new Date();
      const row = await transaction.selectFrom('threads').selectAll()
        .where((eb) => eb.or([eb('locked_at', 'is', null), eb('locked_at', '<', new Date(now.getTime() - leaseMs).toISOString().slice(0, 23).replace('T', ' '))]))
        .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', now.toISOString().slice(0, 23).replace('T', ' '))]))
        .where(sql<boolean>`exists (select 1 from conversation_messages m
          where m.thread_id = threads.id and m.id > threads.summary_cursor
          order by m.id limit 1 offset ${recentLimit + SUMMARY_BATCH_SIZE - 1})`)
        .orderBy('updated_at').orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!row) return null;
      const token = randomUUID();
      const messages = await transaction.selectFrom('conversation_messages').selectAll()
        .where('thread_id', '=', row.id).where('id', '>', row.summary_cursor)
        .orderBy('id').limit(SUMMARY_BATCH_SIZE).execute();
      await transaction.updateTable('threads').set({ lock_token: token, locked_at: now })
        .where('id', '=', row.id).execute();
      return { id: Number(row.id), summary: row.summary, summaryCursor: Number(row.summary_cursor),
        summaryVersion: Number(row.summary_version), token, messages: messages.map(mapMessage) };
    });
  }

  public async completeSummary(batch: SummaryBatch, rawSummary: string) {
    const summary = summarySchema.parse(rawSummary);
    const cursor = batch.messages.at(-1)?.id;
    if (!cursor) throw new Error('Cannot summarize an empty batch');
    const result = await this.database.updateTable('threads').set({
      summary, summary_cursor: cursor, summary_version: batch.summaryVersion + 1,
      lock_token: null, locked_at: null, retry_at: null, last_error: null, updated_at: new Date(),
    }).where('id', '=', batch.id).where('lock_token', '=', batch.token)
      .where('summary_version', '=', batch.summaryVersion).where('summary_cursor', '=', batch.summaryCursor).executeTakeFirstOrThrow();
    return Number(result.numUpdatedRows) === 1;
  }

  public async failSummary(batch: SummaryBatch) {
    await this.database.updateTable('threads').set({ lock_token: null, locked_at: null,
      retry_at: new Date(Date.now() + 30_000), last_error: 'Summary generation failed', updated_at: new Date(),
    }).where('id', '=', batch.id).where('lock_token', '=', batch.token).execute();
  }
}
