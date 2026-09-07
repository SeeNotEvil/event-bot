import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { TelegramGateway, TelegramTextOptions } from '../../telegram/TelegramAdapter.js';
import { StaleAgentTask } from '../../application/StaleAgentTask.js';
import { defineTool } from './Tool.js';

export const sendMessageInputSchema = z.object({
  text: z.string().min(1).max(4096),
  mentionText: z.string().min(1).max(255).nullable(),
});

export function createSendMessageTool(database: Kysely<Database>, telegram: TelegramGateway) {
  return defineTool({
    name: 'send_message',
    description: 'Отправляет твой полный готовый текст без дополнений: ответ, напоминание, вопрос, подтверждение или объяснение ошибки. Для группового фонового напоминания/вопроса включи обращение к указанному получателю напоминаний и передай mentionText — точный, единственный фрагмент text, который нужно сделать упоминанием этого человека. Иначе mentionText=null. Кнопки Да/Нет для вопроса готовности добавляются автоматически по контексту задания. Это terminal tool: сначала выполни все действия запроса; в readiness_response сначала вызови record_readiness, при Нет попроси прислать новый срок через Reply.',
    input: sendMessageInputSchema,
    output: z.object({ success: z.literal(true), transcript: z.string() }),
    terminal: true,
    execute: async (context, input) => {
      await context.beforeStep?.();
      const options: TelegramTextOptions = {};
      if (context.mentionRecipient) {
        const span = input.mentionText;
        const offset = span === null ? -1 : input.text.indexOf(span);
        if (span === null || offset < 0 || input.text.indexOf(span, offset + span.length) !== -1) {
          throw new Error('Include one unambiguous mentionText in your text to address the reminder recipient');
        }
        options.entities = [{ type: 'text_mention', offset, length: span.length,
          user: { id: context.mentionRecipient.id, is_bot: false, first_name: context.mentionRecipient.firstName } }];
      } else if (input.mentionText !== null) {
        throw new Error('No mention recipient is bound to this run; use mentionText=null');
      }
      const trigger = context.trigger;
      if (trigger?.kind === 'notification') {
        if (trigger.notificationKind === 'completion_check') {
          options.reply_markup = { inline_keyboard: [[
            { text: 'Да', callback_data: `ready:${trigger.notificationId}:${trigger.deadlineVersion}:1` },
            { text: 'Нет', callback_data: `ready:${trigger.notificationId}:${trigger.deadlineVersion}:0` },
          ]] };
        } else if (trigger.notificationKind === 'readiness_response') {
          const response = await database.selectFrom('notifications').select('action_applied')
            .where('id', '=', trigger.notificationId).executeTakeFirst();
          if (!response?.action_applied) throw new Error('Call record_readiness before replying');
        }
      }
      await context.beforeSend?.();
      await context.beforeStep?.();
      const messageId = await telegram.sendText(context.telegramChatId, input.text, options);
      context.outgoingMessageId = messageId;
      if (trigger?.kind === 'notification' || trigger?.kind === 'agent_task') {
        const updated = await database.updateTable('notifications').set({ telegram_message_id: messageId })
          .where('id', '=', trigger.notificationId).where('status', '=', 'pending').executeTakeFirstOrThrow();
        if (Number(updated.numUpdatedRows) !== 1) throw new StaleAgentTask();
      }
      return { success: true as const, transcript: input.text };
    },
    transcript: (_input, output) => output.transcript,
  });
}
