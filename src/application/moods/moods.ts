import { DateTime } from 'luxon';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, MoodEntriesTable } from '../../db/types.js';
import { utcDateTimeSchema } from '../../types/domain.js';
import { localDateTimeSchema } from '../notifications/schemas.js';
import { formatDateForDatabase, formatUtcDateTimeInZone, parseLocalDateTime } from '../notifications/time.js';

const id = z.number().int().positive().safe();
const score = z.number().int().min(1).max(10);
const comment = z.string().trim().min(1).max(4_000).nullable();
export const moodSchema = z.object({
  id, score, comment, occurredAt: localDateTimeSchema, occurredAtUtc: utcDateTimeSchema,
  timezone: z.string(), version: id,
});
export const createMoodSchema = z.object({ score, comment, occurredAt: localDateTimeSchema.nullable() });
export const updateMoodSchema = z.object({ id, expectedVersion: id, score, comment, occurredAt: localDateTimeSchema });
export const moodReferenceSchema = z.object({ id, expectedVersion: id });
export const moodResultSchema = z.object({
  success: z.boolean(), reason: z.enum(['NOT_FOUND', 'VERSION_CONFLICT']).nullable(), mood: moodSchema.nullable(),
});
const cursorSchema = z.object({ occurredAtUtc: utcDateTimeSchema, id });
export const searchMoodsSchema = z.object({
  from: localDateTimeSchema.nullable(), to: localDateTimeSchema.nullable(),
  query: z.string().trim().min(1).max(1_000).nullable(), score: score.nullable(),
  limit: z.number().int().min(1).max(100).nullable(), cursor: cursorSchema.nullable(),
});
export const moodPageSchema = z.object({ moods: z.array(moodSchema), nextCursor: cursorSchema.nullable() });
export const moodSummaryInputSchema = z.object({ from: localDateTimeSchema, to: localDateTimeSchema });
export const moodSummarySchema = z.object({
  from: localDateTimeSchema, to: localDateTimeSchema, timezone: z.string(),
  count: z.number().int().nonnegative(), average: z.number().nullable(),
  minimum: score.nullable(), maximum: score.nullable(),
  first: moodSchema.nullable(), last: moodSchema.nullable(),
});

function mapMood(row: Selectable<MoodEntriesTable>, timezone: string) {
  return moodSchema.parse({ id: Number(row.id), score: row.score, comment: row.comment,
    occurredAt: formatUtcDateTimeInZone(row.occurred_at_utc, timezone),
    occurredAtUtc: DateTime.fromSQL(row.occurred_at_utc, { zone: 'utc' }).toISO(),
    timezone, version: Number(row.version) });
}

function localUtc(value: string, timezone: string): string {
  const parsed = parseLocalDateTime(value, timezone);
  if (!parsed) throw new Error('INVALID_LOCAL_TIME');
  return formatDateForDatabase(parsed);
}

function range(from: string | null, to: string | null, timezone: string) {
  const start = from === null ? null : localUtc(from, timezone);
  const end = to === null ? null : localUtc(to, timezone);
  if (start !== null && end !== null && start >= end) throw new Error('from must precede to (exclusive)');
  return { start, end };
}

export async function readMood(database: Kysely<Database>, userId: number, timezone: string, moodId: number) {
  const row = await database.selectFrom('mood_entries').selectAll()
    .where('user_id', '=', userId).where('id', '=', moodId).executeTakeFirst();
  return row ? mapMood(row, timezone) : null;
}

export async function createMood(database: Kysely<Database>, userId: number, timezone: string, now: string,
  rawInput: z.infer<typeof createMoodSchema>) {
  const input = createMoodSchema.parse(rawInput);
  const occurredAt = input.occurredAt === null
    ? formatDateForDatabase(DateTime.fromISO(now, { setZone: true }).startOf('minute'))
    : localUtc(input.occurredAt, timezone);
  return database.transaction().execute(async (transaction) => {
    const result = await transaction.insertInto('mood_entries').values({ user_id: userId,
      score: input.score, comment: input.comment, occurred_at_utc: occurredAt, timezone, updated_at: new Date(),
    }).executeTakeFirstOrThrow();
    if (result.insertId === undefined) throw new Error('Database did not return a mood ID');
    return (await readMood(transaction, userId, timezone, Number(result.insertId)))!;
  });
}

export async function updateMood(database: Kysely<Database>, userId: number, timezone: string,
  rawInput: z.infer<typeof updateMoodSchema>) {
  const input = updateMoodSchema.parse(rawInput);
  const occurredAt = localUtc(input.occurredAt, timezone);
  return changeMood(database, userId, timezone, input, async (transaction) => {
    await transaction.updateTable('mood_entries').set({ score: input.score, comment: input.comment,
      occurred_at_utc: occurredAt, timezone, version: input.expectedVersion + 1, updated_at: new Date(),
    }).where('user_id', '=', userId).where('id', '=', input.id).execute();
    return readMood(transaction, userId, timezone, input.id);
  });
}

export async function deleteMood(database: Kysely<Database>, userId: number, timezone: string,
  rawInput: z.infer<typeof moodReferenceSchema>) {
  const input = moodReferenceSchema.parse(rawInput);
  return changeMood(database, userId, timezone, input, async (transaction) => {
    await transaction.deleteFrom('mood_entries').where('user_id', '=', userId).where('id', '=', input.id).execute();
    return null;
  });
}

async function changeMood(database: Kysely<Database>, userId: number, timezone: string,
  input: z.infer<typeof moodReferenceSchema>, change: (transaction: Kysely<Database>) => Promise<z.infer<typeof moodSchema> | null>) {
  return database.transaction().execute(async (transaction) => {
    const row = await transaction.selectFrom('mood_entries').selectAll()
      .where('user_id', '=', userId).where('id', '=', input.id).forUpdate().executeTakeFirst();
    if (!row) return { success: false, reason: 'NOT_FOUND' as const, mood: null };
    if (Number(row.version) !== input.expectedVersion) {
      return { success: false, reason: 'VERSION_CONFLICT' as const, mood: mapMood(row, timezone) };
    }
    return { success: true, reason: null, mood: await change(transaction) };
  });
}

export async function searchMoods(database: Kysely<Database>, userId: number, timezone: string,
  rawInput: z.infer<typeof searchMoodsSchema>) {
  const input = searchMoodsSchema.parse(rawInput);
  const { start, end } = range(input.from, input.to, timezone);
  let query = database.selectFrom('mood_entries').selectAll().where('user_id', '=', userId);
  if (start !== null) query = query.where('occurred_at_utc', '>=', start);
  if (end !== null) query = query.where('occurred_at_utc', '<', end);
  if (input.score !== null) query = query.where('score', '=', input.score);
  if (input.query !== null) {
    const pattern = `%${input.query.replace(/[!%_]/g, '!$&')}%`;
    query = query.where(sql<boolean>`comment like ${pattern} escape '!'`);
  }
  if (input.cursor !== null) {
    const at = formatDateForDatabase(DateTime.fromISO(input.cursor.occurredAtUtc));
    const cursorId = input.cursor.id;
    query = query.where((eb) => eb.or([eb('occurred_at_utc', '<', at),
      eb.and([eb('occurred_at_utc', '=', at), eb('id', '<', cursorId)])]));
  }
  const limit = input.limit ?? 50;
  const rows = await query.orderBy('occurred_at_utc', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
  const moods = rows.slice(0, limit).map((row) => mapMood(row, timezone));
  const last = moods.at(-1);
  return { moods, nextCursor: rows.length > limit && last ? { occurredAtUtc: last.occurredAtUtc, id: last.id } : null };
}

export async function getMoodSummary(database: Kysely<Database>, userId: number, timezone: string,
  rawInput: z.infer<typeof moodSummaryInputSchema>) {
  const input = moodSummaryInputSchema.parse(rawInput);
  const { start, end } = range(input.from, input.to, timezone);
  return database.transaction().setIsolationLevel('repeatable read').execute(async (transaction) => {
    const base = transaction.selectFrom('mood_entries').where('user_id', '=', userId)
      .where('occurred_at_utc', '>=', start!).where('occurred_at_utc', '<', end!);
    const aggregate = await base.select((eb) => [eb.fn.countAll().as('count'), eb.fn.avg('score').as('average'),
      eb.fn.min('score').as('minimum'), eb.fn.max('score').as('maximum')]).executeTakeFirstOrThrow();
    const first = await base.selectAll().orderBy('occurred_at_utc').orderBy('id').limit(1).executeTakeFirst();
    const last = await base.selectAll().orderBy('occurred_at_utc', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return { ...input, timezone, count: Number(aggregate.count),
      average: aggregate.average === null ? null : Math.round(Number(aggregate.average) * 100) / 100,
      minimum: aggregate.minimum === null ? null : Number(aggregate.minimum),
      maximum: aggregate.maximum === null ? null : Number(aggregate.maximum),
      first: first ? mapMood(first, timezone) : null, last: last ? mapMood(last, timezone) : null };
  });
}
