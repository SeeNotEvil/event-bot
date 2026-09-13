import pino from 'pino';
import { AccessDeniedError, type AccessPolicy } from '../src/application/access/BotAccess.js';

export const silentLogger = pino({ enabled: false });

export const testAccess: AccessPolicy & { requireAllowed: (id: number | null) => Promise<void> } = {
  isOwner: (id) => id === 123,
  isAllowed: async (id) => id === 123,
  requireAllowed: async (id) => { if (id !== 123) throw new AccessDeniedError(); },
};
