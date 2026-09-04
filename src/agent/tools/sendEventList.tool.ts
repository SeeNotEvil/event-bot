import { z } from 'zod';
import { scheduleEventSchema } from '../../application/schedule/schemas.js';
import type { TelegramGateway } from '../../telegram/TelegramAdapter.js';
import { defineTool } from './Tool.js';

export const displayEventSchema = scheduleEventSchema;

export const sendEventListInputSchema = z.object({
  title: z.string().trim().min(1).max(128),
  events: z.array(displayEventSchema).max(100),
});

const sendEventListOutputSchema = z.object({
  success: z.literal(true),
  transcript: z.string(),
});

export function createSendEventListTool(telegram: TelegramGateway) {
  return defineTool({
    name: 'send_event_list',
    description:
      'Показывает структурированный список событий и их напоминаний через Telegram Adapter. Имя текущего пользователя добавляется перед названием каждого события автоматически. Передавай events без изменений из свежего результата search_schedule и не добавляй данные самостоятельно. Это terminal interaction tool.',
    input: sendEventListInputSchema,
    output: sendEventListOutputSchema,
    terminal: true,
    execute: async (context, input) => {
      const transcript = await telegram.sendEventList(
        context.telegramChatId,
        input.title,
        input.events,
        context.now,
        context.firstName,
      );
      return { success: true as const, transcript };
    },
    transcript: (_input, output) => output.transcript,
  });
}
