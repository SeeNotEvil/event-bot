import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { createNote, createNoteSchema, deleteNote, notePageSchema, noteReferenceSchema, noteResultSchema,
  noteSchema, readNote, readNoteSchema, searchNotes, searchNotesSchema, updateNote, updateNoteSchema } from '../../application/notes/notes.js';
import { defineTool } from './Tool.js';

export function createNoteTools(database: Kysely<Database>) {
  return [
    defineTool({ name: 'create_note', requiresUser: true,
      description: 'Создаёт заметку текущего чата: title, полный content и tags ([] без тегов). Текст до 32000 символов, включая Markdown и чек-листы. Теги приводятся к нижнему регистру, повторы удаляются. В личке заметки личные, в группе общие. Автор и чат задаются сервером. Для дополнения существующей заметки сначала используй search_notes/read_note.',
      input: createNoteSchema, output: noteSchema,
      execute: (ctx, input) => createNote(database, ctx.chatId, ctx.userId!, input) }),
    defineTool({ name: 'read_note', requiresUser: true,
      description: 'Читает заметку целиком по ID только в текущем чате, включая автора и актуальную версию. Используй перед дополнением или исправлением текста: search_notes возвращает лишь выдержку. note=null означает, что заметка недоступна или удалена.',
      input: readNoteSchema, output: z.object({ note: noteSchema.nullable() }),
      execute: async (ctx, input) => ({ note: await readNote(database, ctx.chatId, input) }) }),
    defineTool({ name: 'search_notes', requiresUser: true,
      description: 'Ищет заметки текущего чата по фрагменту названия/текста и точному тегу без учёта регистра. query=null и tag=null отключают фильтры. Новые ID первыми; nextBeforeId передай как beforeId для следующей страницы. Возвращает первые 300 символов и contentTruncated; полный текст доступен через read_note.',
      input: searchNotesSchema, output: notePageSchema,
      execute: (ctx, input) => searchNotes(database, ctx.chatId, input) }),
    defineTool({ name: 'update_note', requiresUser: true,
      description: 'Меняет заметку текущего чата по ID и expectedVersion из read_note. Передай полные актуальные title, content и tags, сохранив неизменённый текст и пункты чек-листа. Автор сохраняется. При VERSION_CONFLICT прочитай свежий текст и заново примени нужную правку. История прежних редакций не хранится.',
      input: updateNoteSchema, output: noteResultSchema,
      execute: (ctx, input) => updateNote(database, ctx.chatId, input) }),
    defineTool({ name: 'delete_note', requiresUser: true,
      description: 'Удаляет заметку текущего чата по ID и прочитанной expectedVersion. При конфликте сначала прочитай актуальную запись. Удаление физическое; исходная переписка остаётся в архиве.',
      input: noteReferenceSchema, output: noteResultSchema,
      execute: (ctx, input) => deleteNote(database, ctx.chatId, input) }),
  ];
}
