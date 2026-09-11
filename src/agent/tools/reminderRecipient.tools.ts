import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { TelegramMembershipGateway } from '../../telegram/TelegramAdapter.js';
import { searchChatMembers, chatMemberSchema } from '../../application/chats/chatMembers.js';
import { setReminderRecipient, setReminderRecipientInputSchema, setReminderRecipientOutputSchema } from '../../application/events/setReminderRecipient.js';
import { defineTool } from './Tool.js';

export function createSearchChatMembersTool(database: Kysely<Database>, telegram: TelegramMembershipGateway) {
  return defineTool({
    name: 'search_chat_members', description: 'Ищет человека для упоминания в send_message или назначения получателем напоминаний среди известных участников ТЕКУЩЕГО чата по имени или @username (query=null — до 10 кандидатов). В группе проверяет актуальное членство через Telegram. Учитывает участников переписки, задач, Reply и именные упоминания текущего сообщения; это не полный список группы. При нескольких совпадениях уточни. Если человек неизвестен, попроси его написать в группу или пользователя ответить на его сообщение через Reply. verificationFailed означает, что Telegram не позволил подтвердить членство: не выбирай по догадке.',
    input: z.object({ query: z.string().trim().min(1).max(255).nullable() }),
    output: z.object({ members: z.array(chatMemberSchema), knownMembersOnly: z.literal(true), hasMore: z.boolean(), verificationFailed: z.boolean() }),
    execute: async (context, input) => {
      const result = await searchChatMembers(database, telegram, context, input.query);
      context.resolvedChatMembers = [...new Map([...(context.resolvedChatMembers ?? []), ...result.members]
        .map((member) => [member.telegramUserId, member])).values()];
      return result;
    },
  });
}

export function createSetReminderRecipientTool(database: Kysely<Database>, telegram: TelegramMembershipGateway) {
  return defineTool({
    name: 'set_reminder_recipient', requiresUser: true,
    description: 'Меняет получателя напоминаний и вопросов готовности active-задачи текущего чата без изменения автора, сроков, ID и таймеров. По умолчанию получатель — автор; recipientTelegramUserId=null возвращает этот режим. Для другого человека сначала search_chat_members, затем передай подтверждённый Telegram ID. expectedRecipientVersion возьми из свежего read_event или create_events. Членство проверяется заново; чужой чат, вышедший участник, бот, неподтверждённое членство и устаревшая версия отклоняются. В личке допустим только владелец. При RECIPIENT_CHANGED перечитай задачу. При MEMBERSHIP_UNVERIFIED объясни невозможность проверки; для надёжного getChatMember боту нужны права администратора группы, также возможна сетевая ошибка.',
    input: setReminderRecipientInputSchema, output: setReminderRecipientOutputSchema,
    execute: (context, input) => setReminderRecipient(database, telegram, context, input),
  });
}
