import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { TelegramGateway, TelegramMembershipGateway, TelegramTextOptions } from '../../telegram/TelegramAdapter.js';
import { StaleAgentTask } from '../../application/StaleAgentTask.js';
import { ChatMentionError, checkChatMember } from '../../application/chats/chatMembers.js';
import { defineTool } from './Tool.js';

export const sendMessageInputSchema = z.object({
  text: z.string().min(1).max(4096),
  mentionText: z.string().min(1).max(255).nullable(),
  mentionTelegramUserId: z.number().int().positive().safe().nullable(),
});

export function createSendMessageTool(database: Kysely<Database>, telegram: TelegramGateway & TelegramMembershipGateway) {
  return defineTool({
    name: 'send_message',
    description: 'Отправляет твой полный готовый текст без дополнений. Для упоминания человека по просьбе в группе сначала search_chat_members, затем передай его mentionTelegramUserId и mentionText — точный, единственный фрагмент text, который станет кликабельным именем. Username не обязателен. Для фонового напоминания получатель уже задан сервером: mentionTelegramUserId=null, mentionText — обращение к нему. Без упоминания оба поля null. Кнопки Да/Нет добавляются по контексту. Это terminal tool: сначала выполни все действия; в readiness_response сначала record_readiness, при Нет попроси новый срок через Reply.',
    input: sendMessageInputSchema,
    output: z.object({ success: z.literal(true), transcript: z.string() }),
    terminal: true,
    execute: async (context, input) => {
      await context.beforeStep?.();
      const options: TelegramTextOptions = {};
      let recipient = context.mentionRecipient;
      if (input.mentionTelegramUserId !== null) {
        if (context.chatType !== 'group') throw new ChatMentionError('Упоминание участника доступно только в группе. Для обычного ответа передай оба поля упоминания null.');
        if (recipient && recipient.id !== input.mentionTelegramUserId) {
          throw new ChatMentionError('Получатель фонового напоминания уже задан. Используй mentionTelegramUserId=null и обращение к mention_recipient.');
        }
        if (!recipient) {
          const candidate = context.resolvedChatMembers?.find((member) => member.telegramUserId === input.mentionTelegramUserId);
          if (!candidate) throw new ChatMentionError('Сначала найди этого участника через search_chat_members в текущем запуске. Не угадывай Telegram ID.');
          const checked = await checkChatMember(telegram, context.telegramChatId, candidate.telegramUserId);
          if (!checked.success) throw new ChatMentionError(checked.reason === 'MEMBERSHIP_UNVERIFIED'
            ? 'Telegram не позволил проверить участника. Упоминание не отправлено; сообщи об этом без тега.'
            : 'Этот человек больше не является допустимым участником чата. Упоминание не отправлено; сообщи об этом без тега.');
          recipient = { id: checked.member.telegramUserId, firstName: checked.member.firstName };
        }
      }
      if (recipient) {
        const span = input.mentionText;
        const offset = span === null ? -1 : input.text.indexOf(span);
        if (span === null || offset < 0 || input.text.indexOf(span, offset + span.length) !== -1) {
          throw new ChatMentionError('mentionText должен точно совпадать с единственным фрагментом text, который станет упоминанием.');
        }
        options.entities = [{ type: 'text_mention', offset, length: span.length,
          user: { id: recipient.id, is_bot: false, first_name: recipient.firstName } }];
      } else if (input.mentionText !== null) {
        throw new ChatMentionError('Для упоминания найди участника через search_chat_members и передай mentionTelegramUserId; без упоминания оба поля должны быть null.');
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
