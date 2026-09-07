import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { occurrence } from '../../src/application/scheduler/time.js';

describe('scheduler calendar occurrences', () => {
  it('keeps local time across DST, skips nonexistent times and uses an overlapping hour only once', () => {
    const morning = { frequency: 'daily' as const, time: '09:00', weekdays: null };
    const before = occurrence(morning, 'Europe/Berlin', DateTime.fromISO('2026-03-28T09:00:00+01:00'), 'next');
    expect(before.toISO()).toBe('2026-03-29T07:00:00.000Z');
    const night = { ...morning, time: '02:30' };
    expect(occurrence(night, 'Europe/Berlin', DateTime.fromISO('2026-03-28T02:30:00+01:00'), 'next').toISO())
      .toBe('2026-03-30T00:30:00.000Z');
    const overlap = occurrence(night, 'Europe/Berlin', DateTime.fromISO('2026-10-25T00:00:00Z'), 'next');
    expect(overlap.toISO()).toBe('2026-10-25T00:30:00.000Z');
    expect(occurrence(night, 'Europe/Berlin', overlap, 'next').toISO()).toBe('2026-10-26T01:30:00.000Z');
  });

  it('finds the latest missed weekday directly after a long outage and advances strictly past generated occurrences', () => {
    const rule = { frequency: 'weekly' as const, time: '09:00', weekdays: [1, 5] };
    const now = DateTime.fromISO('2030-04-03T12:00:00Z');
    expect(occurrence(rule, 'Europe/Moscow', now, 'previous', true).toISO()).toBe('2030-04-01T06:00:00.000Z');
    const next = occurrence(rule, 'Europe/Moscow', now, 'next');
    expect(next.toISO()).toBe('2030-04-05T06:00:00.000Z');
    expect(occurrence(rule, 'Europe/Moscow', next, 'previous', true).toISO()).toBe(next.toISO());
    expect(occurrence(rule, 'Europe/Moscow', next, 'next').toISO()).toBe('2030-04-08T06:00:00.000Z');
  });
});
