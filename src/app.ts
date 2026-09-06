import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import OpenAI from 'openai';
import { Bot } from 'grammy';
import { createBrain } from './agent/createBrain.js';
import { ensureChat } from './application/chats/ensureChat.js';
import { ensureUser } from './application/users/ensureUser.js';
import { loadConfig } from './config/config.js';
import { createDatabase } from './db/connection.js';
import { migrateToLatest } from './db/migrate.js';
import { createLogger } from './logger.js';
import { TelegramAdapter } from './telegram/TelegramAdapter.js';
import { registerTelegramHandlers } from './telegram/bot.js';
import { createHttpApp } from './telegram/webhook.js';

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.database);
  const bot = new Bot(config.telegram.token);
  const telegram = new TelegramAdapter(bot.api);
  let server: Server | null = null;
  let shuttingDown = false;

  try {
    await migrateToLatest(database);

    const openai = new OpenAI({
      apiKey: config.openai.apiKey,
      timeout: config.openai.timeoutMs,
      maxRetries: 2,
    });

    const brain = createBrain(database, telegram, openai.responses, config, logger);

    registerTelegramHandlers(bot, {
      brain,
      database,
      ensureUser: (input) => ensureUser(database, input),
      ensureChat: (input) => ensureChat(database, input),
      telegram,
      defaultTimezone: config.defaultTimezone,
      logger,
    });
    await bot.init();

    const webhook =
      config.telegram.mode === 'webhook'
        ? {
            enabled: true as const,
            bot,
            secret: config.telegram.webhookSecret ?? '',
          }
        : { enabled: false as const };
    const httpApp = createHttpApp({ database, logger, webhook });
    server = createServer(httpApp);
    await listen(server, config.port);
    logger.info({ port: config.port }, 'HTTP server started');

    const shutdown = async (reason: NodeJS.Signals | 'POLLING_ERROR'): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info({ reason }, 'Shutting down');

      if (bot.isRunning()) {
        await bot.stop();
      }
      if (server) {
        await closeServer(server);
      }
      await database.destroy();
    };

    // The process manager can repeat a signal while the other process exits.
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    if (config.telegram.mode === 'webhook') {
      if (!config.telegram.webhookUrl || !config.telegram.webhookSecret) {
        throw new Error('Webhook configuration is incomplete');
      }

      await bot.api.setWebhook(config.telegram.webhookUrl, {
        secret_token: config.telegram.webhookSecret,
        allowed_updates: ['message', 'callback_query'],
      });
      logger.info({ webhookUrl: config.telegram.webhookUrl }, 'Telegram webhook registered');
    } else {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      void bot.start({
        allowed_updates: ['message', 'callback_query'],
        onStart: () => logger.info('Telegram polling started'),
      }).catch((error: unknown) => {
        logger.fatal({ error }, 'Telegram polling stopped unexpectedly');
        process.exitCode = 1;
        void shutdown('POLLING_ERROR');
      });
    }
  } catch (error) {
    logger.fatal({ error }, 'Application startup failed');
    if (server) {
      await closeServer(server).catch(() => undefined);
    }
    await database.destroy();
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  console.error(`Application terminated: ${message}`);
  process.exitCode = 1;
});
