import { DateTime } from 'luxon';
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, NotesTable } from '../../db/types.js';
import { utcDateTimeSchema } from '../../types/domain.js';
import { formatDateForDatabase } from '../notifications/time.js';

const id = z.number().int().positive().safe();
const title = z.string().trim().min(1).max(255);
const content = z.string().max(32_000);
const tag = z.string().trim().min(1).max(64);
const tags = z.array(tag).max(20);

export const createNoteSchema = z.object({ title, content, tags });
export const readNoteSchema = z.object({ id });
export const noteReferenceSchema = z.object({ id, expectedVersion: id });
export const updateNoteSchema = createNoteSchema.extend(noteReferenceSchema.shape);
const noteMetadataSchema = z.object({
  id, createdByUserId: id, title, tags, version: id,
  createdAtUtc: utcDateTimeSchema, updatedAtUtc: utcDateTimeSchema,
});
export const noteSchema = noteMetadataSchema.extend({ content });
export const noteResultSchema = z.object({
  success: z.boolean(), reason: z.enum(['NOT_FOUND', 'VERSION_CONFLICT']).nullable(), note: noteSchema.nullable(),
});
export const searchNotesSchema = z.object({
  query: z.string().trim().min(1).max(1_000).nullable(), tag: tag.nullable(),
  beforeId: id.nullable(), limit: z.number().int().min(1).max(50).nullable(),
});
export const notePageSchema = z.object({
  notes: z.array(noteMetadataSchema.extend({ excerpt: z.string(), contentTruncated: z.boolean() })),
  nextBeforeId: id.nullable(),
});

function normalizeTag(value: string) {
  return value.normalize('NFC').trim().toLowerCase();
}

function normalizeTags(values: string[]) {
  return tags.parse([...new Set(values.map(normalizeTag))]);
}

function mapMetadata(row: Omit<Selectable<NotesTable>, 'content'>) {
  return noteMetadataSchema.parse({ id: Number(row.id), createdByUserId: Number(row.created_by_user_id),
    title: row.title, tags: typeof row.tags === 'string' ? JSON.parse(row.tags) as unknown : row.tags,
    version: Number(row.version), createdAtUtc: DateTime.fromSQL(row.created_at, { zone: 'utc' }).toISO(),
    updatedAtUtc: DateTime.fromSQL(row.updated_at, { zone: 'utc' }).toISO() });
}

function mapNote(row: Selectable<NotesTable>) {
  return noteSchema.parse({ ...mapMetadata(row), content: row.content });
}

export async function createNote(database: Kysely<Database>, chatId: number, userId: number,
  rawInput: z.infer<typeof createNoteSchema>) {
  const input = createNoteSchema.parse(rawInput);
  const now = new Date();
  return database.transaction().execute(async (transaction) => {
    const result = await transaction.insertInto('notes').values({ chat_id: chatId, created_by_user_id: userId,
      title: input.title, content: input.content, tags: JSON.stringify(normalizeTags(input.tags)),
      created_at: formatDateForDatabase(now), updated_at: now,
    }).executeTakeFirstOrThrow();
    const noteId = Number(result.insertId);
    if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error('Database did not return a safe note ID');
    return (await readNote(transaction, chatId, { id: noteId }))!;
  });
}

export async function readNote(database: Kysely<Database>, chatId: number, rawInput: z.infer<typeof readNoteSchema>) {
  const input = readNoteSchema.parse(rawInput);
  const row = await database.selectFrom('notes').selectAll().where('chat_id', '=', chatId)
    .where('id', '=', input.id).executeTakeFirst();
  return row ? mapNote(row) : null;
}

export async function searchNotes(database: Kysely<Database>, chatId: number, rawInput: z.infer<typeof searchNotesSchema>) {
  const input = searchNotesSchema.parse(rawInput);
  // Fetch excerpts in SQL so listing notes never loads entire documents.
  let query = database.selectFrom('notes')
    .select(['id', 'chat_id', 'created_by_user_id', 'title', 'tags', 'version', 'created_at', 'updated_at'])
    .select([sql<string>`left(content, 300)`.as('excerpt'), sql<number>`char_length(content) > 300`.as('content_truncated')])
    .where('chat_id', '=', chatId);
  if (input.query !== null) {
    const pattern = `%${input.query.replace(/[!%_]/g, '!$&')}%`;
    query = query.where(sql<boolean>`(title like ${pattern} escape '!' or content like ${pattern} escape '!')`);
  }
  if (input.tag !== null) query = query.where(sql<boolean>`json_contains(tags, ${JSON.stringify(normalizeTag(input.tag))})`);
  if (input.beforeId !== null) query = query.where('id', '<', input.beforeId);
  const limit = input.limit ?? 20;
  const rows = await query.orderBy('id', 'desc').limit(limit + 1).execute();
  const notes = rows.slice(0, limit).map((row) => ({ ...mapMetadata(row), excerpt: row.excerpt,
    contentTruncated: Boolean(row.content_truncated) }));
  return { notes, nextBeforeId: rows.length > limit ? notes.at(-1)!.id : null };
}

export async function updateNote(database: Kysely<Database>, chatId: number, rawInput: z.infer<typeof updateNoteSchema>) {
  const input = updateNoteSchema.parse(rawInput);
  return changeNote(database, chatId, input, input);
}

export async function deleteNote(database: Kysely<Database>, chatId: number, rawInput: z.infer<typeof noteReferenceSchema>) {
  return changeNote(database, chatId, noteReferenceSchema.parse(rawInput), null);
}

async function changeNote(database: Kysely<Database>, chatId: number, ref: z.infer<typeof noteReferenceSchema>,
  update: z.infer<typeof updateNoteSchema> | null) {
  return database.transaction().execute(async (transaction) => {
    const row = await transaction.selectFrom('notes').selectAll().where('chat_id', '=', chatId)
      .where('id', '=', ref.id).forUpdate().executeTakeFirst();
    if (!row) return { success: false, reason: 'NOT_FOUND' as const, note: null };
    if (Number(row.version) !== ref.expectedVersion) {
      return { success: false, reason: 'VERSION_CONFLICT' as const, note: mapNote(row) };
    }
    if (update === null) {
      await transaction.deleteFrom('notes').where('chat_id', '=', chatId).where('id', '=', ref.id).execute();
      return { success: true, reason: null, note: null };
    }
    await transaction.updateTable('notes').set({ title: update.title, content: update.content,
      tags: JSON.stringify(normalizeTags(update.tags)), version: ref.expectedVersion + 1, updated_at: new Date(),
    }).where('chat_id', '=', chatId).where('id', '=', ref.id).execute();
    return { success: true, reason: null, note: await readNote(transaction, chatId, { id: ref.id }) };
  });
}
