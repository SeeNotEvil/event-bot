import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { Api } from 'grammy';
import OpenAI from 'openai';
import { ReminderTextGenerator } from './agent/ReminderTextGenerator.js';
import { processDueNotifications } from './application/notifications/processDueNotifications.js';
import { loadConfig } from './config/config.js';
import { createDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { createLogger } from './logger.js';
import { formatEventReminder, TelegramAdapter } from './telegram/TelegramAdapter.js';

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
  const reminderTextGenerator = new ReminderTextGenerator(
    openai.responses,
    config.openai.model,
    config.openai.maxOutputTokens,
  );
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
          prepareMessage: async (notification) => {
            const localNow = DateTime.now().setZone(notification.timezone).toISO({
              suppressMilliseconds: true,
            }) ?? new Date().toISOString();
            try {
              return await reminderTextGenerator.generate(notification, localNow);
            } catch (error) {
              logger.warn(
                {
                  notificationId: notification.notificationId,
                  errorType: error instanceof Error ? error.name : 'UnknownError',
                },
                'Reminder generation failed; using standard reminder',
              );
              return formatEventReminder(
                {
                  id: notification.eventId,
                  title: notification.eventTitle,
                  dateFrom: notification.eventDateFrom,
                  dateTo: notification.eventDateTo,
                  time: notification.eventTime,
                },
                localNow,
                notification.createdByName,
              );
            }
          },
          send: async (notification, message) => {
            await telegram.sendMessage(notification.telegramChatId, message);
          },
        });

        if (result.claimed > 0) {
          logger.info(result, 'Notification batch processed');
        }
      } catch (error) {
        logger.error({ error }, 'Notification batch failed');
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
