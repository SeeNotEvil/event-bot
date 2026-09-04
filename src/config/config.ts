import { DateTime } from 'luxon';
import { z } from 'zod';

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    TELEGRAM_WEBHOOK_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().optional(),
    ),
    TELEGRAM_WEBHOOK_SECRET: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
    ),

    OPENAI_API_KEY: z.string().min(1),
    OPENAI_MODEL: z.string().min(1).default('gpt-5.4-mini'),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(128_000)
      .default(16_384),

    DEFAULT_TIMEZONE: z
      .string()
      .default('Europe/Moscow')
      .refine((value) => DateTime.now().setZone(value).isValid, 'Must be a valid IANA timezone'),
    MAX_AGENT_STEPS: z.coerce.number().int().min(1).max(50).default(10),
    CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().min(2).max(100).default(50),

    NOTIFICATION_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(5_000),
    NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    NOTIFICATION_LOCK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(3_600_000)
      .default(60_000),

    MYSQL_HOST: z.string().min(1).default('127.0.0.1'),
    MYSQL_PORT: z.coerce.number().int().min(1).max(65_535).default(3306),
    MYSQL_DATABASE: z.string().min(1).default('telegram_event_bot'),
    MYSQL_USER: z.string().min(1).default('telegram_event_bot'),
    MYSQL_PASSWORD: z.string().min(1),
  })
  .superRefine((environment, context) => {
    if (environment.TELEGRAM_MODE !== 'webhook') {
      return;
    }

    if (!environment.TELEGRAM_WEBHOOK_URL) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_URL'],
        message: 'Required when TELEGRAM_MODE=webhook',
      });
    }

    if (!environment.TELEGRAM_WEBHOOK_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'Required when TELEGRAM_MODE=webhook',
      });
    }
  });

export type AppConfig = {
  environment: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  telegram: {
    token: string;
    mode: 'polling' | 'webhook';
    webhookUrl: string | null;
    webhookSecret: string | null;
  };
  openai: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
  };
  defaultTimezone: string;
  maxAgentSteps: number;
  conversationHistoryLimit: number;
  notificationWorker: {
    pollIntervalMs: number;
    batchSize: number;
    lockTimeoutMs: number;
  };
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = environmentSchema.parse(source);

  return {
    environment: environment.NODE_ENV,
    port: environment.PORT,
    logLevel: environment.LOG_LEVEL,
    telegram: {
      token: environment.TELEGRAM_BOT_TOKEN,
      mode: environment.TELEGRAM_MODE,
      webhookUrl: environment.TELEGRAM_WEBHOOK_URL ?? null,
      webhookSecret: environment.TELEGRAM_WEBHOOK_SECRET ?? null,
    },
    openai: {
      apiKey: environment.OPENAI_API_KEY,
      model: environment.OPENAI_MODEL,
      timeoutMs: environment.OPENAI_TIMEOUT_MS,
      maxOutputTokens: environment.OPENAI_MAX_OUTPUT_TOKENS,
    },
    defaultTimezone: environment.DEFAULT_TIMEZONE,
    maxAgentSteps: environment.MAX_AGENT_STEPS,
    conversationHistoryLimit: environment.CONVERSATION_HISTORY_LIMIT,
    notificationWorker: {
      pollIntervalMs: environment.NOTIFICATION_POLL_INTERVAL_MS,
      batchSize: environment.NOTIFICATION_BATCH_SIZE,
      lockTimeoutMs: environment.NOTIFICATION_LOCK_TIMEOUT_MS,
    },
    database: {
      host: environment.MYSQL_HOST,
      port: environment.MYSQL_PORT,
      database: environment.MYSQL_DATABASE,
      user: environment.MYSQL_USER,
      password: environment.MYSQL_PASSWORD,
    },
  };
}
