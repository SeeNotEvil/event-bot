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
      'Показывает структурированный список событий, их авторов и напоминаний через Telegram Adapter. Передавай events без изменений из свежего результата search_schedule и не добавляй данные самостоятельно. Сформулируй короткий и точный title в узнаваемом голосе Ираиды, естественно используя активное обращение или лёгкий церемониальный оборот; не добавляй в title факты, которых нет в результате поиска. Это terminal interaction tool.',
    input: sendEventListInputSchema,
    output: sendEventListOutputSchema,
    terminal: true,
    execute: async (context, input) => {
      const transcript = await telegram.sendEventList(
        context.telegramChatId,
        input.title,
        input.events,
        context.now,
      );
      return { success: true as const, transcript };
    },
    transcript: (_input, output) => output.transcript,
  });
}
