import type { Kysely } from 'kysely';
import { rescheduleEvent } from '../../application/events/rescheduleEvent.js';
import {
  rescheduleEventInputSchema,
  rescheduleEventOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createRescheduleEventTool(database: Kysely<Database>) {
  return defineTool({
    name: 'reschedule_event',
    requiresUser: true,
    description: 'Атомарно переносит active-задачу и её уведомления. Сначала получи актуальную задачу через search_events/read_event. Передай полные dateFrom/dateTo/time; отсутствие даты допустимо, если оба остальных поля null. reminderTimes=null сохраняет режим и пересчитывает стандартные напоминания; для старой задачи включает стандартные правила. Явный массив заменяет предварительные напоминания, [] отключает их. Если есть пользовательские pending-напоминания, сначала выясни их новые моменты. Перенос делает старые кнопки готовности недействительными.',
    input: rescheduleEventInputSchema,
    output: rescheduleEventOutputSchema,
    execute: (context, input) =>
      rescheduleEvent(
        database,
        context.calendarId,
        context.timezone,
        context.now,
        input,
      ),
  });
}
