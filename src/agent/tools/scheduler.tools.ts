import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { AgentContext } from '../../types/domain.js';
import { Scheduler } from '../../application/scheduler/Scheduler.js';
import { createScheduleSchema, deleteScheduleSchema, scheduleOnceSchema, schedulePageSchema,
  scheduleResultSchema, scheduleSchema, searchSchedulesSchema, updateScheduleSchema } from '../../application/scheduler/schemas.js';
import { changeNotification, queueChangeSchema, updateNotificationSchema } from '../../application/scheduler/queue.js';
import { localDateTimeSchema } from '../../application/notifications/schemas.js';
import { defineTool } from './Tool.js';

export function scheduleOwner(context: AgentContext) {
  if (context.userId === null) throw new Error('A task owner is required');
  return { userId: context.userId, chatId: context.chatId, timezone: context.timezone };
}

export function createSchedulerTools(database: Kysely<Database>) {
  const scheduler = new Scheduler(database);
  return [
    defineTool({ name: 'schedule_once', requiresUser: true,
      description: 'Сразу ставит в очередь одно будущее поручение тебе. instruction — что сделать при запуске любыми доступными tools; remindAt — конкретные местные дата/время текущего чата. eventId=null для самостоятельного поручения; известный eventId связывает запуск с активной задачей, чтобы перенос/завершение отменяли старый запуск. Можно планировать по собственной инициативе и из фонового поручения.',
      input: scheduleOnceSchema, output: z.object({ notificationId: z.number(), remindAt: localDateTimeSchema, timezone: z.string() }),
      execute: (ctx, input) => scheduler.once(scheduleOwner(ctx), new Date(ctx.now), input) }),
    defineTool({ name: 'create_schedule', requiresUser: true,
      description: 'Сохраняет регулярное поручение тебе: произвольную instruction, daily или weekly, местное время и weekdays (1=пн, 7=вс; null для daily). Воркер держит один будущий запуск. Содержание, частоту и время выбираешь сама по ситуации; отдельное разрешение на регулярность не требуется. eventId=null для самостоятельного поручения либо известный ID связанной активной задачи. Перед созданием проверь search_schedules, чтобы не создавать случайные дубли.',
      input: createScheduleSchema, output: scheduleSchema,
      execute: (ctx, input) => scheduler.create(scheduleOwner(ctx), new Date(ctx.now), input) }),
    defineTool({ name: 'search_schedules', requiresUser: true,
      description: 'Читает собственные расписания в текущем чате, их инструкции, правила, версии и ближайшее ожидающее уведомление. null отключает фильтр; nextBeforeId передай как beforeId для следующей страницы. nextUnqueuedAt — курсор генерации, он может быть позже уже созданного уведомления.',
      input: searchSchedulesSchema, output: schedulePageSchema,
      execute: (ctx, input) => scheduler.search(scheduleOwner(ctx), input) }),
    defineTool({ name: 'update_schedule', requiresUser: true,
      description: 'Обновляет прочитанное расписание по ID и expectedVersion. Передай полное поручение, правило и enabled. Отменяет старые неотправленные запуски, включая текущий, если меняешь собственное выполняющееся расписание. enabled=false приостанавливает, true возобновляет с ближайшего будущего времени.',
      input: updateScheduleSchema, output: scheduleResultSchema,
      execute: (ctx, input) => scheduler.update(scheduleOwner(ctx), new Date(ctx.now), input) }),
    defineTool({ name: 'delete_schedule', requiresUser: true,
      description: 'Отключает прочитанное расписание и отменяет все его неотправленные уведомления. ID и expectedVersion возьми из search_schedules. История запусков сохраняется.',
      input: deleteScheduleSchema, output: scheduleResultSchema,
      execute: (ctx, input) => scheduler.delete(scheduleOwner(ctx), new Date(ctx.now), input) }),
    defineTool({ name: 'update_notification', requiresUser: true,
      description: 'Меняет время или поручение отдельного pending-уведомления по ID и expectedVersion из search_notifications. Для agent_task передай полный instruction, для обычного напоминания instruction=null. Для запуска повторяющегося расписания используй update_schedule; один запуск можно отменить delete_notification.',
      input: updateNotificationSchema, output: queueChangeSchema,
      execute: (ctx, input) => changeNotification(database, scheduleOwner(ctx), new Date(ctx.now), input.notificationId, input) }),
    defineTool({ name: 'finish_task',
      description: 'Успешно завершает текущее фоновое поручение без сообщения в Telegram. Используй, когда отправлять нечего или поручение выполнено через другие tools. Это terminal tool.',
      availableWhen: (ctx) => ctx.trigger?.kind === 'agent_task',
      input: z.object({}), output: z.object({ success: z.literal(true) }), terminal: true,
      execute: async (ctx) => { await ctx.beforeStep?.(); return { success: true as const }; } }),
  ];
}
