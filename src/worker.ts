import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from 'grammy';
import OpenAI from 'openai';
import { createBrain } from './agent/createBrain.js';
import { requireChatMember } from './application/chats/chatMembers.js';
import { MysqlThreadMemory } from './application/memory/MysqlThreadMemory.js';
import { SummaryUpdater } from './application/memory/SummaryUpdater.js';
import { claimChatList, renewListClaim, releaseListClaim, StaleAgentTask } from './application/schedule/chatList.js';
import { processDueNotifications } from './application/notifications/processDueNotifications.js';
import { loadConfig } from './config/config.js';
import { createDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { createLogger } from './logger.js';
import { TelegramAdapter } from './telegram/TelegramAdapter.js';

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runNotificationWorker(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.database);
  const requestTimeoutMs = Math.min(10_000, Math.floor(config.notificationWorker.lockTimeoutMs / 3));
  const telegram = new TelegramAdapter(new Api(config.telegram.token, {
    timeoutSeconds: requestTimeoutMs / 1000,
  }));
  const openai = new OpenAI({
    apiKey: config.openai.apiKey,
    timeout: Math.min(config.openai.timeoutMs, requestTimeoutMs),
    maxRetries: 0,
  });
  const brain = createBrain(database, telegram, openai.responses, config, logger);
  const summaryTimeoutMs = Math.min(config.openai.timeoutMs, 20_000);
  const summaryClient = new OpenAI({ apiKey: config.openai.apiKey, timeout: summaryTimeoutMs, maxRetries: 0 });
  const summaries = new SummaryUpdater(new MysqlThreadMemory(database), summaryClient.responses,
    config.openai.model, config.conversationHistoryLimit, Math.max(config.notificationWorker.lockTimeoutMs, summaryTimeoutMs + 5_000),
    config.openai.maxOutputTokens, logger);
  const abortController = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    if (abortController.signal.aborted) {
      return;
    }
    logger.info({ signal }, 'Stopping notification worker');
    abortController.abort();
  };
  const onSigint = (): void => stop('SIGINT');
  const onSigterm = (): void => stop('SIGTERM');

  // Repeated signals must not interrupt an in-flight delivery or database cleanup.
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    await migrateToLatest(database);
    logger.info(
      {
        pollIntervalMs: config.notificationWorker.pollIntervalMs,
        batchSize: config.notificationWorker.batchSize,
      },
      'Notification worker started',
    );

    while (!abortController.signal.aborted) {
      const startedAt = Date.now();
      const now = new Date();

      try {
        const result = await processDueNotifications(database, {
          now,
          batchSize: config.notificationWorker.batchSize,
          lockTimeoutMs: config.notificationWorker.lockTimeoutMs,
          signal: abortController.signal,
          run: async (notification, guard) => {
            const checkRecipient = async () => {
              if (notification.chatType === 'group') {
                await requireChatMember(telegram, notification.telegramChatId, notification.reminderRecipientTelegramId);
              }
            };
            await checkRecipient();
            const result = await brain.handleBackground(notification.chatId, {
              kind: 'notification', notificationId: notification.notificationId,
              eventId: notification.eventId, deadlineVersion: notification.deadlineVersion,
              notificationKind: notification.kind, answer: notification.answer,
            }, {
              beforeStep: guard,
              beforeSend: checkRecipient,
              mentionRecipient: notification.chatType === 'group'
                ? { id: notification.reminderRecipientTelegramId, firstName: notification.reminderRecipientName } : undefined,
            });
            if (result.messageId === undefined) throw new Error('Agent did not deliver a notification');
          },
        });

        if (result.claimed > 0) {
          logger.info(result, 'Notification batch processed');
        }
      } catch (error) {
        logger.error({ error }, 'Notification batch failed');
      }

      if (!abortController.signal.aborted) {
        try {
          const list = await claimChatList(database, config.notificationWorker.lockTimeoutMs);
          if (list) {
            try {
              await brain.handleBackground(Number(list.chat_id), {
                kind: 'list_refresh', revision: Number(list.revision), page: Number(list.page),
              }, {
                listClaimToken: list.token,
                beforeStep: async () => {
                  if (abortController.signal.aborted) throw new Error('Worker is stopping');
                  await renewListClaim(database, Number(list.chat_id), list.token, Number(list.revision));
                },
              });
            } catch (error) {
              await releaseListClaim(database, Number(list.chat_id), list.token, !(error instanceof StaleAgentTask));
              if (!(error instanceof StaleAgentTask)) logger.error({ error, chatId: list.chat_id }, 'Chat list agent failed');
            }
          }
        } catch (error) {
          logger.error({ error }, 'Chat list dispatch failed');
        }
      }

      if (!abortController.signal.aborted) {
        try {
          await summaries.processNext();
        } catch (error) {
          logger.error({ error }, 'Thread summary dispatch failed');
        }
      }

      const elapsed = Date.now() - startedAt;
      await wait(
        Math.max(0, config.notificationWorker.pollIntervalMs - elapsed),
        abortController.signal,
      );
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await database.destroy();
    logger.info('Notification worker stopped');
  }
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryFile === currentFile) {
  void runNotificationWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown worker error';
    console.error(`Notification worker terminated: ${message}`);
    process.exitCode = 1;
  });
}
