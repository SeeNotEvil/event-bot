import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { publishChatList } from '../../application/schedule/chatList.js';
import type { TelegramGateway } from '../../telegram/TelegramAdapter.js';
import { defineTool } from './Tool.js';

export const sendEventListInputSchema = z.object({ text: z.string().min(1).max(4096) });

export function createSendEventListTool(database: Kysely<Database>, telegram: TelegramGateway) {
  return defineTool({
    name: 'send_event_list',
    description: 'Публикует написанный тобой полный текст текущей страницы общего активного списка: заголовок, все пункты и пояснения. Сначала вызови read_task_list после всех изменений. Сохрани все задачи страницы и их порядок, точные названия, даты, время и авторов. Покажи номер страницы, если страниц несколько. Тулс только отправляет или редактирует одно сообщение, оформляет кнопки страниц и проверяет версию данных. Для выборок по фильтрам используй search_schedule и send_message. Это terminal tool: сначала выполни все части поручения.',
    input: sendEventListInputSchema,
    output: z.object({ success: z.literal(true), transcript: z.string() }),
    terminal: true,
    execute: async (context, input) => {
      if (context.trigger?.kind === 'notification') throw new Error('Deliver the notification using send_message');
      context.outgoingMessageId = await publishChatList(database, telegram, context, input.text);
      return { success: true as const, transcript: input.text };
    },
    transcript: (_input, output) => output.transcript,
  });
}
