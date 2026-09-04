import { DateTime } from 'luxon';
import type { Selectable } from 'kysely';
import type { EventsTable } from '../../db/types.js';
import { eventSchema, type EventDto } from '../../types/domain.js';

export function mapEvent(row: Selectable<EventsTable>): EventDto {
  const completedAt = row.completed_at === null
    ? null
    : DateTime.fromSQL(row.completed_at, { zone: 'utc' }).toUTC().toISO();

  if (row.completed_at !== null && completedAt === null) {
    throw new Error('Database returned an invalid event completion timestamp');
  }

  return eventSchema.parse({
    id: Number(row.id),
    title: row.title,
    description: row.description,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    time: row.time === null ? null : row.time.slice(0, 5),
    status: row.status,
    completedAt,
  });
}
