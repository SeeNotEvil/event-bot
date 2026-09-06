import type { Kysely } from 'kysely';
import { z } from 'zod';
import { MysqlMemoryStore } from '../memory/MysqlMemoryStore.js';
import type { MemorySource } from '../memory/MemoryStore.js';
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
  return (await new MysqlMemoryStore(database).get({ kind: 'user', id: userId }, 'profile'))?.content ?? null;
}

export async function saveUserPreferences(
  database: Kysely<Database>, userId: number, rawInput: SaveUserPreferencesInput,
  source: MemorySource = { messageId: null, label: 'preferences' },
  expectedVersion?: number | null,
): Promise<SaveUserPreferencesOutput> {
  const input = saveUserPreferencesInputSchema.parse(rawInput);
  const store = new MysqlMemoryStore(database);
  const namespace = { kind: 'user' as const, id: userId };
  const previous = await store.get(namespace, 'profile');
  const version = expectedVersion === undefined ? previous?.version ?? null : expectedVersion;
  const result = input.preferences === null
    ? previous ? await store.forget(namespace, previous.id, version ?? 0) : { success: true }
    : await store.save(namespace, { key: 'profile', kind: 'procedural', content: input.preferences, expectedVersion: version }, source);
  if (!result.success) throw new Error('Preferences changed concurrently; read the current profile and retry');
  return { success: true, preferences: input.preferences };
}
