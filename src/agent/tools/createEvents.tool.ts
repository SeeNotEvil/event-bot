import type { Kysely } from 'kysely';
import { createEvents } from '../../application/events/createEvents.js';
import {
  createEventsInputSchema,
  createEventsOutputSchema,
} from '../../application/events/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export const createEventsToolDescription =
  'Атомарно создаёт полный набор из 1–100 событий текущего календаря. В личном чате это личный календарь, в группе — общий календарь группы; scope задаётся приложением и не выбирается моделью. Передай одним вызовом все события из запроса: tool либо создаст весь набор, либо не создаст ничего. Для каждого события дата должна однозначно вычисляться из current datetime и timezone; точные относительные даты и ближайшая непрошедшая дата без года допустимы. Нормализуй время вроде «13 00» в HH:mm. Не пропускай неясные позиции: сначала уточни их. Точные дубликаты требуют уточнения. Напоминания этот tool не создаёт; если пользователь явно запросил их, но время неизвестно, уточни его до изменения данных. После успеха продолжи остальные части поручения, включая явно запрошенные напоминания. В общем итоговом ответе перечисли все созданные события, если их не больше 10; для 11–100 сообщи количество и общий dateRange. Вопрос о необязательных напоминаниях отложи до общего итога.';

export function createCreateEventsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'create_events',
    description: createEventsToolDescription,
    input: createEventsInputSchema,
    output: createEventsOutputSchema,
    execute: (context, input) =>
      createEvents(database, context.calendarId, context.userId, input),
  });
}
