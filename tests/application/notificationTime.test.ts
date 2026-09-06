import { describe, expect, it } from 'vitest';
import { localDateTimeSchema } from '../../src/application/notifications/schemas.js';
import { planNotifications } from '../../src/application/notifications/configureNotifications.js';
import {
  formatDateForDatabase,
  formatUtcDateTimeInZone,
  parseLocalDateTime,
} from '../../src/application/notifications/time.js';

describe('notification time conversion', () => {
  it('plans the agreed defaults for an interval, one date, and an undated task', () => {
    const plan = (dateFrom: string | null, dateTo: string | null) => planNotifications(
      { dateFrom, dateTo }, 'Europe/Moscow', '2026-10-01T15:00:00+03:00', 'default', [], true,
    ).map((target) => ({ kind: target.kind, at: formatUtcDateTimeInZone(target.at, 'Europe/Moscow') }));
    expect(plan('2026-10-05', '2026-10-11')).toEqual([
      { kind: 'reminder', at: '2026-10-04T10:00' },
      { kind: 'reminder', at: '2026-10-10T10:00' },
      { kind: 'completion_check', at: '2026-10-12T10:00' },
    ]);
    expect(plan('2026-10-05', '2026-10-05')).toEqual(plan('2026-10-05', null));
    expect(plan(null, null)).toEqual([]);
  });

  it('skips missed advance reminders and respects an explicit opt-out', () => {
    const dates = { dateFrom: '2026-10-05', dateTo: null };
    const now = '2026-10-08T11:00:00+03:00';
    expect(planNotifications(dates, 'Europe/Moscow', now, 'default', [], true)).toEqual([
      { kind: 'completion_check', source: 'automatic', at: '2026-10-09 07:00:00.000' },
    ]);
    expect(planNotifications(dates, 'Europe/Moscow', now, 'off', [], false)).toEqual([]);
    expect(planNotifications(dates, 'Europe/Moscow', now, 'custom', ['2026-10-10T19:00'], false))
      .toEqual([{ kind: 'reminder', source: 'manual', at: '2026-10-10 16:00:00.000' }]);
  });
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
