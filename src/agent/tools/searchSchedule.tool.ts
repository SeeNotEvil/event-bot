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
      'Read-only поиск выборки расписания с авторами и уведомлениями текущего календаря. Диапазон события проверяет пересечение дат. requireReminder=false сохраняет задачи без совпавших уведомлений, true оставляет только задачи с ними. Null statuses означают active-задачи и pending-уведомления; completed запроси явно. kind отличает reminder от completion_check. Составь ответ сама и отправь через send_message. Для постоянного активного списка используй read_task_list, для изменения сначала перечитай цель через search_events/read_event.',
    input: searchScheduleInputSchema,
    output: searchScheduleOutputSchema,
    execute: (context, input) =>
      searchSchedule(database, context.chatId, context.timezone, input),
  });
}
