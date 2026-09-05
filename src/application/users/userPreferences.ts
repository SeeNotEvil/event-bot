import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';

export const userPreferencesSchema = z.string().trim().min(1).max(4_000).nullable();

export const saveUserPreferencesInputSchema = z.object({
  preferences: userPreferencesSchema,
});

export type SaveUserPreferencesInput = z.infer<typeof saveUserPreferencesInputSchema>;

export const saveUserPreferencesOutputSchema = z.object({
  success: z.literal(true),
  preferences: userPreferencesSchema,
});

export type SaveUserPreferencesOutput = z.infer<typeof saveUserPreferencesOutputSchema>;

export async function getUserPreferences(
  database: Kysely<Database>,
  userId: number,
): Promise<string | null> {
  const row = await database
    .selectFrom('user_preferences')
    .select('content')
    .where('user_id', '=', userId)
    .executeTakeFirst();

  return row?.content ?? null;
}

export async function saveUserPreferences(
  database: Kysely<Database>,
  userId: number,
  rawInput: SaveUserPreferencesInput,
): Promise<SaveUserPreferencesOutput> {
  const input = saveUserPreferencesInputSchema.parse(rawInput);

  if (input.preferences === null) {
    await database.deleteFrom('user_preferences').where('user_id', '=', userId).execute();
    return saveUserPreferencesOutputSchema.parse({
      success: true,
      preferences: null,
    });
  }

  const now = new Date();
  await database
    .insertInto('user_preferences')
    .values({
      user_id: userId,
      content: input.preferences,
      updated_at: now,
    })
    .onDuplicateKeyUpdate({
      content: input.preferences,
      updated_at: now,
    })
    .executeTakeFirstOrThrow();

  return saveUserPreferencesOutputSchema.parse({
    success: true,
    preferences: input.preferences,
  });
}
