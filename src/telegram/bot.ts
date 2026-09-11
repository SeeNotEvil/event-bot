import type { Bot, Context } from 'grammy';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../db/types.js';
import type { EnsureChatInput } from '../application/chats/ensureChat.js';
import type { EnsureUserInput } from '../application/users/ensureUser.js';
import { enqueueReadinessAnswer } from '../application/notifications/readiness.js';
import type { BotBrain } from '../agent/BotBrain.js';
import type { Chat, User } from '../types/domain.js';
import { extractGroupRequest } from './groupMessage.js';
import { KeyedSerialQueue } from './KeyedSerialQueue.js';
import type { TelegramGateway } from './TelegramAdapter.js';

export type EnsureUserAction = (input: EnsureUserInput) => Promise<User>;
export type EnsureChatAction = (input: EnsureChatInput) => Promise<Chat>;
export type TelegramBotDependencies = {
  database: Kysely<Database>; brain: BotBrain; ensureUser: EnsureUserAction; ensureChat: EnsureChatAction;
  telegram: TelegramGateway; defaultTimezone: string; logger: Logger; queue?: KeyedSerialQueue;
};

export function registerTelegramHandlers(bot: Bot, dependencies: TelegramBotDependencies): void {
  const queue = dependencies.queue ?? new KeyedSerialQueue();
  async function identify(context: Context) {
    if (!context.from || !context.chat) throw new Error('Telegram update has no user/chat');
    const isPrivate = context.chat.type === 'private';
    const user = await dependencies.ensureUser({
      telegramUserId: context.from.id, telegramChatId: isPrivate ? context.chat.id : null,
      telegramUsername: context.from.username ?? null, firstName: context.from.first_name,
      lastName: context.from.last_name ?? null, defaultTimezone: dependencies.defaultTimezone,
    });
    const chat = await dependencies.ensureChat(isPrivate
      ? { type: 'personal', userId: user.id, timezone: user.timezone }
      : { type: 'group', telegramChatId: context.chat.id, title: context.chat.title, timezone: dependencies.defaultTimezone });
    return { user, chat };
  }

  bot.on('message', async (context) => {
    if (!context.from || context.from.is_bot) return;
    const chatId = context.chat.id;
    const isPrivate = context.chat.type === 'private';
    const text = context.message.text ?? context.message.caption;
    if (!text && !isPrivate) return;
    await queue.run(`chat:${chatId}`, async () => {
      try {
        const { user, chat } = await identify(context);
        const metadata = { messageId: context.message.message_id,
          replyToMessageId: context.message.reply_to_message?.message_id };
        if (!text) {
          await dependencies.brain.handleMessage(JSON.stringify({ received: 'non_text_message' }), user, chat,
            chatId, context.chat.type, { ...metadata, serviceReason: 'Only text input is currently supported. Explain this to the user.' });
          return;
        }
        const inserted = await dependencies.brain.rememberMessage(text, user, chat, metadata);
        if (!inserted) return;
        const request = isPrivate ? text : extractGroupRequest({ text,
          entities: context.message.entities ?? context.message.caption_entities ?? [],
          replyToBot: context.message.reply_to_message?.from?.id === context.me.id,
          botUsername: context.me.username,
        });
        const reply = context.message.reply_to_message;
        const groupMessage = isPrivate ? undefined : {
          directlyAddressed: request !== null,
        };
        const replyTo = reply ? {
          messageId: reply.message_id,
          author: reply.from?.id === context.me.id ? 'Мэй Мэй'
            : reply.from ? [reply.from.first_name, reply.from.last_name].filter(Boolean).join(' ')
            : reply.sender_chat?.title ?? 'Участник',
          text: reply.text ?? reply.caption ?? null,
          quote: context.message.quote?.text ?? null,
          sentAt: new Date(reply.date * 1000).toISOString(),
        } : null;
        const referencedUsers = [
          context.message.reply_to_message?.from,
          ...(context.message.entities ?? context.message.caption_entities ?? [])
            .flatMap((entity) => entity.type === 'text_mention' ? [entity.user] : []),
        ].filter((person) => person !== undefined).filter((person) => !person.is_bot);
        const recipientReferences = referencedUsers.map((person) => ({
          telegramUserId: person.id, firstName: person.first_name,
          lastName: person.last_name ?? null, username: person.username ?? null,
        }));
        await dependencies.brain.handleMessage(request ?? text, user, chat, chatId, context.chat.type,
          { ...metadata, stored: true, recipientReferences, groupMessage, replyTo });
      } catch (error) {
        dependencies.logger.error({ error, telegramChatId: chatId }, 'Telegram message processing failed');
      }
    });
  });

  bot.on('callback_query:data', async (context) => {
    await context.answerCallbackQuery();
    if (!context.chat || !context.callbackQuery.message || context.from.is_bot) return;
    const messageId = context.callbackQuery.message.message_id;
    const chatId = context.chat.id;
    const data = context.callbackQuery.data;
    await queue.run(`chat:${chatId}`, async () => {
      try {
        const { chat } = await identify(context);
        const readiness = /^ready:(\d+):(\d+):([01])$/.exec(data);
        if (readiness) {
          const id = Number(readiness[1]);
          const version = Number(readiness[2]);
          if (!Number.isSafeInteger(id) || !Number.isSafeInteger(version)) return;
          const accepted = await enqueueReadinessAnswer(dependencies.database, chat.id, messageId, id, version, readiness[3] === '1');
          if (accepted) await dependencies.telegram.clearButtons(chatId, messageId);
          return;
        }
      } catch (error) {
        dependencies.logger.error({ error, telegramChatId: chatId }, 'Telegram callback processing failed');
      }
    });
  });

  bot.catch((error) => {
    dependencies.logger.error({ error: error.error, updateId: error.ctx.update.update_id }, 'Unhandled grammY error');
  });
}
