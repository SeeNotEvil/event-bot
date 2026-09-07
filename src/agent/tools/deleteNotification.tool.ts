import type { Kysely } from 'kysely';
import { changeNotification, queueChangeSchema } from '../../application/scheduler/queue.js';
import { scheduleOwner } from './scheduler.tools.js';
import {
  deleteNotificationInputSchema,
} from '../../application/notifications/schemas.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createDeleteNotificationTool(database: Kysely<Database>) {
  return defineTool({
    name: 'delete_notification',
    requiresUser: true,
    description:
      'Отменяет одно выбранное pending-уведомление текущего чата: напоминание задачи или собственное agent_task. ID возьми из search_notifications. У повторяющегося расписания пропускается только этот запуск; воркер не создаст его заново. Для остановки всей серии используй delete_schedule.',
    input: deleteNotificationInputSchema,
    output: queueChangeSchema,
    execute: (context, input) => changeNotification(database, scheduleOwner(context), new Date(context.now), input.notificationId, null),
  });
}
