import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { EnsureUserInput } from '../application/users/ensureUser.js';
import type { BotBrain } from '../agent/BotBrain.js';
import type { User } from '../types/domain.js';
import { KeyedSerialQueue } from './KeyedSerialQueue.js';
import type { TelegramGateway } from './TelegramAdapter.js';

export type EnsureUserAction = (input: EnsureUserInput) => Promise<User>;

export type TelegramBotDependencies = {
  brain: BotBrain;
  ensureUser: EnsureUserAction;
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
    if (telegramContext.chat.type !== 'private' || !telegramContext.from) {
      return;
    }

    const chatId = telegramContext.chat.id;
    const telegramUserId = telegramContext.from.id;
    const text = telegramContext.message.text;

    if (!text) {
      await dependencies.telegram.sendMessage(chatId, TEXT_ONLY_MESSAGE);
      return;
    }

    await queue.run(String(telegramUserId), async () => {
      try {
        const user = await dependencies.ensureUser({
          telegramUserId,
          telegramChatId: chatId,
          telegramUsername: telegramContext.from.username ?? null,
          firstName: telegramContext.from.first_name,
          lastName: telegramContext.from.last_name ?? null,
          defaultTimezone: dependencies.defaultTimezone,
        });
        await dependencies.brain.handleMessage(text, user);
      } catch (error) {
        dependencies.logger.error(
          { error, telegramUserId },
          'Telegram update processing failed',
        );

        try {
          await dependencies.telegram.sendMessage(chatId, GENERIC_ERROR_MESSAGE);
        } catch (sendError) {
          dependencies.logger.error(
            { error: sendError, telegramUserId },
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
