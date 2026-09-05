import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { EnsureCalendarInput } from '../application/calendars/ensureCalendar.js';
import type { EnsureUserInput } from '../application/users/ensureUser.js';
import type { BotBrain } from '../agent/BotBrain.js';
import type { Calendar, TelegramChatType, User } from '../types/domain.js';
import { extractGroupRequest } from './groupMessage.js';
import { KeyedSerialQueue } from './KeyedSerialQueue.js';
import type { TelegramGateway } from './TelegramAdapter.js';

export type EnsureUserAction = (input: EnsureUserInput) => Promise<User>;
export type EnsureCalendarAction = (input: EnsureCalendarInput) => Promise<Calendar>;

export type TelegramBotDependencies = {
  brain: BotBrain;
  ensureUser: EnsureUserAction;
  ensureCalendar: EnsureCalendarAction;
  telegram: TelegramGateway;
  defaultTimezone: string;
  logger: Logger;
  queue?: KeyedSerialQueue;
};

const GENERIC_ERROR_MESSAGE = 'Не удалось обработать сообщение. Попробуйте ещё раз чуть позже.';
const TEXT_ONLY_MESSAGE = 'Пока я понимаю только текстовые сообщения.';

export function registerTelegramHandlers(
  bot: Bot,
  dependencies: TelegramBotDependencies,
): void {
  const queue = dependencies.queue ?? new KeyedSerialQueue();

  bot.on('message', async (telegramContext) => {
    if (
      !telegramContext.from ||
      telegramContext.from.is_bot
    ) {
      return;
    }

    const chatId = telegramContext.chat.id;
    const telegramUserId = telegramContext.from.id;
    const text = telegramContext.message.text;
    const chatType: TelegramChatType = telegramContext.chat.type;
    const isPrivate = chatType === 'private';

    if (!text) {
      if (isPrivate) {
        await dependencies.telegram.sendMessage(chatId, TEXT_ONLY_MESSAGE);
      }
      return;
    }

    const request = isPrivate
      ? text
      : extractGroupRequest({
          text,
          entities: telegramContext.message.entities ?? [],
          replyToBot:
            telegramContext.message.reply_to_message?.from?.id === telegramContext.me.id,
          botUsername: telegramContext.me.username,
        });

    if (request === null) {
      return;
    }

    await queue.run(`chat:${chatId}`, async () => {
      try {
        const user = await dependencies.ensureUser({
          telegramUserId,
          telegramChatId: isPrivate ? chatId : null,
          telegramUsername: telegramContext.from.username ?? null,
          firstName: telegramContext.from.first_name,
          lastName: telegramContext.from.last_name ?? null,
          defaultTimezone: dependencies.defaultTimezone,
        });
        const calendar = await dependencies.ensureCalendar(
          isPrivate
            ? {
                type: 'personal',
                userId: user.id,
                timezone: user.timezone,
              }
            : {
                type: 'group',
                telegramChatId: chatId,
                title: telegramContext.chat.title ?? `Группа ${chatId}`,
                timezone: dependencies.defaultTimezone,
              },
        );
        await dependencies.brain.handleMessage(
          request,
          user,
          calendar,
          chatId,
          chatType,
        );
      } catch (error) {
        dependencies.logger.error(
          { error, telegramUserId, telegramChatId: chatId },
          'Telegram update processing failed',
        );

        try {
          await dependencies.telegram.sendMessage(chatId, GENERIC_ERROR_MESSAGE);
        } catch (sendError) {
          dependencies.logger.error(
            { error: sendError, telegramUserId, telegramChatId: chatId },
            'Failed to send fallback message',
          );
        }
      }
    });
  });

  bot.catch((error) => {
    dependencies.logger.error(
      { error: error.error, updateId: error.ctx.update.update_id },
      'Unhandled grammY error',
    );
  });
}
