import type { Bot } from 'grammy';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../src/db/types.js';
import { createHttpApp } from '../../src/telegram/webhook.js';
import { silentLogger } from '../helpers.js';

describe('HTTP infrastructure', () => {
  it('reports database health', async () => {
    const database = {} as Kysely<Database>;
    const healthy = createHttpApp({
      database,
      logger: silentLogger,
      healthCheck: async () => true,
      webhook: { enabled: false },
    });
    const unhealthy = createHttpApp({
      database,
      logger: silentLogger,
      healthCheck: async () => false,
      webhook: { enabled: false },
    });

    await request(healthy).get('/health').expect(200, { status: 'ok', database: 'up' });
    await request(unhealthy)
      .get('/health')
      .expect(503, { status: 'unhealthy', database: 'down' });
  });

  it('authenticates and accepts Telegram webhook updates', async () => {
    const handleUpdate = vi.fn(async () => undefined);
    const bot = { handleUpdate } as unknown as Bot;
    const app = createHttpApp({
      database: {} as Kysely<Database>,
      logger: silentLogger,
      healthCheck: async () => true,
      webhook: { enabled: true, bot, secret: 'secret-value' },
    });

    await request(app).post('/telegram/webhook').send({ update_id: 1 }).expect(401);
    await request(app)
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'secret-value')
      .send({ nope: true })
      .expect(400, { error: 'invalid_update' });
    await request(app)
      .post('/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'secret-value')
      .send({ update_id: 42 })
      .expect(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(handleUpdate).toHaveBeenCalledWith({ update_id: 42 });
  });
});
