import express, { type Express } from 'express';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { isDatabaseHealthy } from '../db/connection.js';
import type { Database } from '../db/types.js';

const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
}).passthrough();

export type HttpAppDependencies = {
  database: Kysely<Database>;
  logger: Logger;
  healthCheck?: () => Promise<boolean>;
  webhook:
    | { enabled: false }
    | {
        enabled: true;
        bot: Bot;
        secret: string;
      };
};

export function createHttpApp(dependencies: HttpAppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger: dependencies.logger }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_request, response) => {
    const databaseHealthy = await (dependencies.healthCheck?.() ??
      isDatabaseHealthy(dependencies.database));
    response.status(databaseHealthy ? 200 : 503).json({
      status: databaseHealthy ? 'ok' : 'unhealthy',
      database: databaseHealthy ? 'up' : 'down',
    });
  });

  if (dependencies.webhook.enabled) {
    const webhook = dependencies.webhook;
    app.post('/telegram/webhook', (request, response) => {
      const secret = request.header('x-telegram-bot-api-secret-token');
      if (secret !== webhook.secret) {
        response.sendStatus(401);
        return;
      }

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_update' });
        return;
      }

      response.sendStatus(200);
      void webhook.bot.handleUpdate(parsed.data as Update).catch((error: unknown) => {
        dependencies.logger.error(
          { error, updateId: parsed.data.update_id },
          'Asynchronous webhook processing failed',
        );
      });
    });
  }

  return app;
}
