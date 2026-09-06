import { z } from 'zod';
import type { TelegramGateway } from '../../telegram/TelegramAdapter.js';
import { defineTool } from './Tool.js';

export const sendMessageInputSchema = z.object({
  text: z.string().trim().min(1).max(4096),
});

const sendMessageOutputSchema = z.object({
  success: z.literal(true),
  transcript: z.string(),
});

export function createSendMessageTool(telegram: TelegramGateway) {
  return defineTool({
    name: 'send_message',
    description:
      'Отправляет пользователю обычное текстовое сообщение: общий итог поручения, необходимое уточнение, объяснение ошибки, ответ на общий вопрос или реплику в свободном разговоре. Это terminal interaction tool: после него выполнение прекращается. Вызывай его только после всех частей поручения либо когда дальнейшая работа требует уточнения или остановлена ошибкой. Не подтверждай отдельно первую операцию, пока остаются другие выполнимые действия. При частичном выполнении явно укажи, что сделано и что осталось. Если созданы события, а напоминания не были указаны и пользователь от них не отказался, text обязательно должен содержать вопрос, нужны ли напоминания и когда. Каждый содержательный text должен включать хотя бы один естественный признак голоса Ираиды из system instructions: церемониальный оборот, активное обращение или лёгкий тёмный образ; конкретную форму выбирай самостоятельно и не повторяй механически. Короткая техническая ошибка или однословный ответ могут быть нейтральными.',
    input: sendMessageInputSchema,
    output: sendMessageOutputSchema,
    terminal: true,
    execute: async (context, input) => {
      const transcript = await telegram.sendMessage(context.telegramChatId, input.text);
      return { success: true as const, transcript };
    },
    transcript: (_input, output) => output.transcript,
  });
}
