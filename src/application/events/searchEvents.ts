import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { EventDto } from '../../types/domain.js';
import { mapEvent } from './mapEvent.js';
import { searchEventsInputSchema, type SearchEventsInput } from './schemas.js';

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export async function searchEvents(
  database: Kysely<Database>,
  calendarId: number,
  rawInput: SearchEventsInput,
): Promise<{ events: EventDto[] }> {
  const input = searchEventsInputSchema.parse(rawInput);
  const statuses = input.statuses ?? ['active'];
  let query = database
    .selectFrom('events')
    .selectAll()
    .where('calendar_id', '=', calendarId)
    .where('status', 'in', statuses);

  if (input.query !== null) {
    const pattern = `%${escapeLikePattern(input.query)}%`;
    query = query.where((expression) =>
      expression.or([
        expression('title', 'like', pattern),
        expression('description', 'like', pattern),
      ]),
    );
  }

  if (input.dateFrom !== null) {
    query = query.where(
      sql<boolean>`coalesce(${sql.ref('date_to')}, ${sql.ref('date_from')}) >= ${input.dateFrom}`,
    );
  }

  if (input.dateTo !== null) {
    query = query.where('date_from', '<=', input.dateTo);
  }

  const rows = await query
    .orderBy('date_from', 'asc')
    .orderBy('time', 'asc')
    .orderBy('id', 'asc')
    .limit(input.limit ?? 50)
    .execute();

  return { events: rows.map(mapEvent) };
}
