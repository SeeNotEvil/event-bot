import { DateTime } from 'luxon';

const LOCAL_DATE_TIME_FORMAT = "yyyy-MM-dd'T'HH:mm";
const DATABASE_DATE_TIME_FORMAT = 'yyyy-MM-dd HH:mm:ss.SSS';

export function parseLocalDateTime(value: string, timezone: string): DateTime | null {
  const parsed = DateTime.fromFormat(value, LOCAL_DATE_TIME_FORMAT, {
    zone: timezone,
    setZone: true,
  });

  if (!parsed.isValid || parsed.toFormat(LOCAL_DATE_TIME_FORMAT) !== value) {
    return null;
  }

  return parsed;
}

export function formatUtcDateTimeInZone(value: string, timezone: string): string {
  const parsed = DateTime.fromSQL(value, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new Error('Database returned an invalid notification timestamp');
  }

  return parsed.setZone(timezone).toFormat(LOCAL_DATE_TIME_FORMAT);
}

export function formatDateForDatabase(value: DateTime | Date): string {
  const parsed = DateTime.isDateTime(value)
    ? value.toUTC()
    : DateTime.fromJSDate(value, { zone: 'utc' });

  if (!parsed.isValid) {
    throw new Error('Cannot format an invalid UTC timestamp');
  }

  return parsed.toFormat(DATABASE_DATE_TIME_FORMAT);
}
