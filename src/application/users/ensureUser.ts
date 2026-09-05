import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { User } from '../../types/domain.js';

const ensureUserInputSchema = z.object({
  telegramUserId: z.number().int().positive().safe(),
  telegramChatId: z.number().int().positive().safe().nullable(),
  telegramUsername: z.string().trim().min(1).max(255).nullable(),
  firstName: z.string().trim().min(1).max(255),
  lastName: z.string().trim().min(1).max(255).nullable(),
  defaultTimezone: z.string().min(1).max(64),
});

export type EnsureUserInput = z.infer<typeof ensureUserInputSchema>;

export async function ensureUser(database: Kysely<Database>, rawInput: EnsureUserInput): Promise<User> {
  const input = ensureUserInputSchema.parse(rawInput);
  const now = new Date();

  const profileUpdate = {
    telegram_username: input.telegramUsername,
    first_name: input.firstName,
    last_name: input.lastName,
    updated_at: now,
    ...(input.telegramChatId === null
      ? {}
      : { telegram_chat_id: input.telegramChatId }),
  };

  await database
    .insertInto('users')
    .values({
      telegram_user_id: input.telegramUserId,
      telegram_chat_id: input.telegramChatId,
      telegram_username: input.telegramUsername,
      first_name: input.firstName,
      last_name: input.lastName,
      timezone: input.defaultTimezone,
      updated_at: now,
    })
    .onDuplicateKeyUpdate(profileUpdate)
    .execute();

  const row = await database
    .selectFrom('users')
    .select([
      'id',
      'telegram_user_id',
      'telegram_chat_id',
      'telegram_username',
      'first_name',
      'last_name',
      'timezone',
    ])
    .where('telegram_user_id', '=', input.telegramUserId)
    .executeTakeFirstOrThrow();

  const firstName = row.first_name ?? input.firstName;
  const displayName = [firstName, row.last_name].filter(Boolean).join(' ');

  return {
    id: Number(row.id),
    telegramUserId: Number(row.telegram_user_id),
    telegramChatId: Number(row.telegram_chat_id),
    telegramUsername: row.telegram_username,
    firstName,
    lastName: row.last_name,
    displayName,
    timezone: row.timezone,
  };
}
