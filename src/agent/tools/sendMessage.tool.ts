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
      'Отправляет пользователю обычное текстовое сообщение: подтверждение, уточнение, объяснение, ответ на общий вопрос или реплику в свободном разговоре. Это terminal interaction tool: вызывай его последним.',
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
