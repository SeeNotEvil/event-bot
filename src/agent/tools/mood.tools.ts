import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { createMood, createMoodSchema, deleteMood, getMoodSummary, moodPageSchema, moodReferenceSchema,
  moodResultSchema, moodSchema, moodSummaryInputSchema, moodSummarySchema, readMood,
  searchMoods, searchMoodsSchema, updateMood, updateMoodSchema } from '../../application/moods/moods.js';
import { defineTool } from './Tool.js';

export function createMoodTools(database: Kysely<Database>) {
  return [
    defineTool({ name: 'create_mood', requiresUser: true,
      description: 'Записывает настроение текущего пользователя: целая оценка 1–10, comment=null без причины, occurredAt=null для текущего момента или местные дата/время чата. Дневник общий между чатами. Записывай сообщённую оценку, не придумывай её.',
      input: createMoodSchema, output: moodSchema,
      execute: (ctx, input) => createMood(database, ctx.userId!, ctx.timezone, ctx.now, input) }),
    defineTool({ name: 'read_mood', requiresUser: true,
      description: 'Читает запись текущего пользователя по ID с её версией. Время показано в зоне текущего чата.',
      input: z.object({ id: z.number().int().positive().safe() }), output: z.object({ mood: moodSchema.nullable() }),
      execute: async (ctx, input) => ({ mood: await readMood(database, ctx.userId!, ctx.timezone, input.id) }) }),
    defineTool({ name: 'search_moods', requiresUser: true,
      description: 'Ищет записи текущего пользователя из всех чатов по периоду [from, to), оценке и комментарию. Времена местные для текущего чата; null отключает фильтр. Новые моменты первыми, nextCursor передавай как cursor для следующей страницы.',
      input: searchMoodsSchema, output: moodPageSchema,
      execute: (ctx, input) => searchMoods(database, ctx.userId!, ctx.timezone, input) }),
    defineTool({ name: 'update_mood', requiresUser: true,
      description: 'Исправляет собственную запись по ID и expectedVersion из чтения. Передай полные актуальные score, occurredAt и comment, сохранив неизменённые поля. comment=null очищает причину. При конфликте перечитай запись.',
      input: updateMoodSchema, output: moodResultSchema,
      execute: (ctx, input) => updateMood(database, ctx.userId!, ctx.timezone, input) }),
    defineTool({ name: 'delete_mood', requiresUser: true,
      description: 'Удаляет собственную запись дневника по ID и прочитанной expectedVersion. Исходные сообщения переписки не удаляются.',
      input: moodReferenceSchema, output: moodResultSchema,
      execute: (ctx, input) => deleteMood(database, ctx.userId!, ctx.timezone, input) }),
    defineTool({ name: 'get_mood_summary', requiresUser: true,
      description: 'Считает статистику настроения текущего пользователя за любой выбранный период [from, to) в зоне чата: количество, среднее, минимум, максимум, первую и последнюю записи. Для причин и деталей читай search_moods. Выводы и формат сообщения выбираешь сама.',
      input: moodSummaryInputSchema, output: moodSummarySchema,
      execute: (ctx, input) => getMoodSummary(database, ctx.userId!, ctx.timezone, input) }),
  ];
}
