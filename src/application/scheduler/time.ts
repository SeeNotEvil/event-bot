import type { DateTime } from 'luxon';
import { parseLocalDateTime } from '../notifications/time.js';
import { recurrenceSchema, type Recurrence } from './schemas.js';

/** Calendar occurrences, including one earliest occurrence on an overlapping DST hour. */
export function occurrence(rule: Recurrence, timezone: string, reference: DateTime,
  direction: 'next' | 'previous', inclusive = false): DateTime {
  recurrenceSchema.parse(rule);
  const local = reference.setZone(timezone);
  if (!local.isValid) throw new Error('INVALID_TIMEZONE');
  const step = direction === 'next' ? 1 : -1;
  for (let offset = 0; offset <= 21; offset++) {
    const day = local.startOf('day').plus({ days: offset * step });
    if (rule.frequency === 'weekly' && !rule.weekdays!.includes(day.weekday)) continue;
    const parsed = parseLocalDateTime(`${day.toISODate()}T${rule.time}`, timezone);
    if (!parsed) continue;
    const at = parsed.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0]!;
    const delta = (at.toMillis() - reference.toMillis()) * step;
    if (delta > 0 || (inclusive && delta === 0)) return at.toUTC();
  }
  throw new Error('No valid calendar occurrence found');
}
