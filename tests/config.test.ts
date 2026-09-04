import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

const baseEnvironment = {
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  OPENAI_API_KEY: 'openai-key',
  MYSQL_PASSWORD: 'mysql-password',
};

describe('loadConfig', () => {
  it('applies V1 defaults', () => {
    const config = loadConfig(baseEnvironment);
    expect(config.telegram.mode).toBe('polling');
    expect(config.openai.model).toBe('gpt-5.4-mini');
    expect(config.openai.maxOutputTokens).toBe(16_384);
    expect(config.defaultTimezone).toBe('Europe/Moscow');
    expect(config.maxAgentSteps).toBe(10);
    expect(config.conversationHistoryLimit).toBe(50);
    expect(config.notificationWorker).toEqual({
      pollIntervalMs: 5_000,
      batchSize: 20,
      lockTimeoutMs: 60_000,
    });
  });

  it('accepts empty webhook variables in polling mode', () => {
    const config = loadConfig({
      ...baseEnvironment,
      TELEGRAM_MODE: 'polling',
      TELEGRAM_WEBHOOK_URL: '',
      TELEGRAM_WEBHOOK_SECRET: '',
    });

    expect(config.telegram.webhookUrl).toBeNull();
    expect(config.telegram.webhookSecret).toBeNull();
  });

  it('requires URL and secret in webhook mode', () => {
    expect(() => loadConfig({ ...baseEnvironment, TELEGRAM_MODE: 'webhook' })).toThrow();
  });
});
