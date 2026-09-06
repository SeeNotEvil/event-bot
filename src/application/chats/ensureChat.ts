import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { Chat } from '../../types/domain.js';

const personalChatInputSchema = z.object({
  type: z.literal('personal'),
  userId: z.number().int().positive().safe(),
  timezone: z.string().min(1).max(64),
});

const groupChatInputSchema = z.object({
  type: z.literal('group'),
  telegramChatId: z.number().int().safe(),
  title: z.string().trim().min(1).max(255),
  timezone: z.string().min(1).max(64),
});

export const ensureChatInputSchema = z.discriminatedUnion('type', [
  personalChatInputSchema,
  groupChatInputSchema,
]);

export type EnsureChatInput = z.infer<typeof ensureChatInputSchema>;

export async function ensureChat(
  database: Kysely<Database>,
  rawInput: EnsureChatInput,
): Promise<Chat> {
  const input = ensureChatInputSchema.parse(rawInput);
  const now = new Date();

  if (input.type === 'personal') {
    await database
      .insertInto('chats')
      .values({
        type: 'personal',
        user_id: input.userId,
        telegram_chat_id: null,
        title: null,
        timezone: input.timezone,
        updated_at: now,
      })
      .onDuplicateKeyUpdate({ updated_at: now })
      .execute();
  } else {
    await database
      .insertInto('chats')
      .values({
        type: 'group',
        user_id: null,
        telegram_chat_id: input.telegramChatId,
        title: input.title,
        timezone: input.timezone,
        updated_at: now,
      })
      .onDuplicateKeyUpdate({ title: input.title, updated_at: now })
      .execute();
  }

  const row = input.type === 'personal'
    ? await database
        .selectFrom('chats')
        .selectAll()
        .where('type', '=', 'personal')
        .where('user_id', '=', input.userId)
        .executeTakeFirstOrThrow()
    : await database
        .selectFrom('chats')
        .selectAll()
        .where('type', '=', 'group')
        .where('telegram_chat_id', '=', input.telegramChatId)
        .executeTakeFirstOrThrow();

  return {
    id: Number(row.id),
    type: input.type,
    userId: row.user_id === null ? null : Number(row.user_id),
    telegramChatId:
      row.telegram_chat_id === null ? null : Number(row.telegram_chat_id),
    title: row.title,
    timezone: row.timezone,
  };
}
