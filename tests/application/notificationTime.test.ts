import { describe, expect, it } from 'vitest';
import { localDateTimeSchema } from '../../src/application/notifications/schemas.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from '../../src/application/notifications/time.js';

describe('notification time conversion', () => {
  it('converts a local IANA time to UTC and back', () => {
    const local = parseLocalDateTime('2026-09-12T18:00', 'Europe/Moscow');

    expect(local?.toUTC().toISO()).toBe('2026-09-12T15:00:00.000Z');
    expect(formatDateForDatabase(local!)).toBe('2026-09-12 15:00:00.000');
    expect(
      formatUtcDateTimeInZone('2026-09-12 15:00:00.000', 'Europe/Moscow'),
    ).toBe('2026-09-12T18:00');
  });

  it('rejects impossible calendar and local DST times', () => {
    expect(localDateTimeSchema.safeParse('2026-02-30T10:00').success).toBe(false);
    expect(parseLocalDateTime('2026-03-29T02:30', 'Europe/Berlin')).toBeNull();
  });
});
