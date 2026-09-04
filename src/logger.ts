import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    serializers: {
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-telegram-bot-api-secret-token',
        '*.token',
        '*.apiKey',
        '*.password',
      ],
      censor: '[redacted]',
    },
  });
}
