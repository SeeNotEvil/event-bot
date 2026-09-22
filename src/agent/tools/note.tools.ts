import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { createNote, createNoteSchema, deleteNote, notePageSchema, noteReferenceSchema, noteResultSchema,
  noteSchema, readNote, readNoteSchema, searchNotes, searchNotesSchema, updateNote, updateNoteSchema } from '../../application/notes/notes.js';
import { defineTool } from './Tool.js';

export function createNoteTools(database: Kysely<Database>) {
  return [
    defineTool({ name: 'create_note', requiresUser: true,
      description: 'По просьбе пользователя создаёт его личную заметку: title, полный content и tags ([] без тегов). Текст до 32000 символов, включая Markdown и чек-листы. Теги приводятся к нижнему регистру, повторы удаляются. Блокнот пользователя един для всех чатов. Владелец и чат создания задаются сервером. Для дополнения существующей заметки сначала используй search_notes/read_note.',
      input: createNoteSchema, output: noteSchema,
      execute: (ctx, input) => createNote(database, ctx.chatId, ctx.userId!, input) }),
    defineTool({ name: 'read_note', requiresUser: true,
      description: 'Читает заметку текущего пользователя целиком по ID из любого чата, включая владельца и актуальную версию. Используй перед дополнением или исправлением текста: search_notes возвращает лишь выдержку. note=null означает, что заметка недоступна или удалена.',
      input: readNoteSchema, output: z.object({ note: noteSchema.nullable() }),
      execute: async (ctx, input) => ({ note: await readNote(database, ctx.userId!, input) }) }),
    defineTool({ name: 'search_notes', requiresUser: true,
      description: 'Ищет личные заметки текущего пользователя из всех чатов по фрагменту названия/текста и точному тегу без учёта регистра. query=null и tag=null отключают фильтры. Новые ID первыми; nextBeforeId передай как beforeId для следующей страницы. Возвращает первые 300 символов и contentTruncated; полный текст доступен через read_note.',
      input: searchNotesSchema, output: notePageSchema,
      execute: (ctx, input) => searchNotes(database, ctx.userId!, input) }),
    defineTool({ name: 'update_note', requiresUser: true,
      description: 'Меняет личную заметку текущего пользователя из любого чата по ID и expectedVersion из read_note. Передай полные актуальные title, content и tags, сохранив неизменённый текст и пункты чек-листа. Владелец и чат создания сохраняются. При VERSION_CONFLICT прочитай свежий текст и заново примени нужную правку. История прежних редакций не хранится.',
      input: updateNoteSchema, output: noteResultSchema,
      execute: (ctx, input) => updateNote(database, ctx.userId!, input) }),
    defineTool({ name: 'delete_note', requiresUser: true,
      description: 'Удаляет личную заметку текущего пользователя из любого чата по ID и прочитанной expectedVersion. При конфликте сначала прочитай актуальную запись. Удаление физическое; исходная переписка остаётся в архиве.',
      input: noteReferenceSchema, output: noteResultSchema,
      execute: (ctx, input) => deleteNote(database, ctx.userId!, input) }),
  ];
}
