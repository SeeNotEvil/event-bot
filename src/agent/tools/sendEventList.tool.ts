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
      'Показывает структурированный список событий, их авторов и напоминаний через Telegram Adapter. Обязательное предусловие: сначала получи список через search_schedule после всех изменений текущего поручения. Результат create_events не заменяет этот поиск. Передавай events без изменений из результата search_schedule и не добавляй данные самостоятельно. Сформулируй короткий и точный title в узнаваемом голосе Ираиды, естественно используя активное обращение или лёгкий церемониальный оборот; подтверждение изменений в title должно опираться на успешные результаты соответствующих tools. Это terminal interaction tool: после него выполнение прекращается. Сначала выполни все части поручения, затем покажи итоговый список. Если общий итог, уточнение или вопрос о напоминаниях не помещается в title, используй send_message с нужными сведениями вместо этого tool.',
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
