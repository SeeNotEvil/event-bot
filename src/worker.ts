import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { Api } from 'grammy';
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
  const telegram = new TelegramAdapter(new Api(config.telegram.token));
  const abortController = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Stopping notification worker');
    abortController.abort();
  };
  const onSigint = (): void => stop('SIGINT');
  const onSigterm = (): void => stop('SIGTERM');

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

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
          send: async (notification) => {
            const localNow = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(
              notification.timezone,
            );
            await telegram.sendEventReminder(
              notification.telegramChatId,
              {
                id: notification.eventId,
                title: notification.eventTitle,
                dateFrom: notification.eventDateFrom,
                dateTo: notification.eventDateTo,
                time: notification.eventTime,
              },
              localNow.toISO({ suppressMilliseconds: true }) ?? now.toISOString(),
              notification.createdByName,
            );
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
