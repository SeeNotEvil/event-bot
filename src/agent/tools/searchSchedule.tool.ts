import type { Kysely } from 'kysely';
import {
  searchScheduleInputSchema,
  searchScheduleOutputSchema,
} from '../../application/schedule/schemas.js';
import { searchSchedule } from '../../application/schedule/searchSchedule.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createSearchScheduleTool(database: Kysely<Database>) {
  return defineTool({
    name: 'search_schedule',
    description:
      'Универсальный read-only поиск для ответа о расписании: возвращает события текущего календаря с авторами и подходящими напоминаниями. В группе это общий календарь группы. Фильтры событий и напоминаний независимы; диапазон события проверяет пересечение дат. requireReminder=false сохраняет события без совпавших напоминаний, true оставляет только события с ними. Null statuses означают active-события и pending-напоминания; completed нужно запросить явно. Результат подходит для send_event_list, но его id нельзя использовать для последующего изменения без свежего специализированного поиска.',
    input: searchScheduleInputSchema,
    output: searchScheduleOutputSchema,
    execute: (context, input) =>
      searchSchedule(database, context.calendarId, context.timezone, input),
  });
}
