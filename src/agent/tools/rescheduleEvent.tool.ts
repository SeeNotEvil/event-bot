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
    description:
      'Атомарно переносит одно однозначно выбранное active-событие текущего календаря и полностью заменяет набор его pending-напоминаний. Получи событие через свежий search_events, а напоминания через search_notifications. Передай полные dateFrom, dateTo и time: не указанные пользователем время и длительность интервала сохраняй из найденного события. reminderTimes — полный новый набор YYYY-MM-DDTHH:mm; [] означает отсутствие напоминаний. Если pending-напоминания есть, а пользователь не задал их новые моменты и не попросил отменить, сначала уточни и ничего не меняй. Timezone и текущее время берутся из контекста.',
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
