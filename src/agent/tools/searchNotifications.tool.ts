import type { Kysely } from 'kysely';
import { searchQueue, searchQueueSchema, queuePageSchema } from '../../application/scheduler/queue.js';
import { scheduleOwner } from './scheduler.tools.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createSearchNotificationsTool(database: Kysely<Database>) {
  return defineTool({
    name: 'search_notifications',
    requiresUser: true,
    description:
      'Читает очередь текущего чата: напоминания задач и собственные agent_task. null отключает фильтр; statuses=null выбирает pending. Можно искать по notificationId, scheduleId, eventId и включительному местному диапазону. Новые ID первыми; nextBeforeId передай как beforeId для следующей страницы. Возвращает instruction и version для изменения, ID для точечной отмены.',
    input: searchQueueSchema,
    output: queuePageSchema,
    execute: (context, input) =>
      searchQueue(database, scheduleOwner(context), input),
  });
}
