import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { eventSchema } from '../../types/domain.js';
import { mapEvent } from './mapEvent.js';
import {
  createEventsInputSchema,
  createEventsOutputSchema,
  type CreateEventsInput,
  type CreateEventsOutput,
} from './schemas.js';

export async function createEvents(
  database: Kysely<Database>,
  calendarId: number,
  createdByUserId: number,
  rawInput: CreateEventsInput,
): Promise<CreateEventsOutput> {
  const input = createEventsInputSchema.parse(rawInput);
  const dateFrom = input.events.reduce(
    (earliest, event) => (event.dateFrom < earliest ? event.dateFrom : earliest),
    input.events[0]?.dateFrom ?? '',
  );
  const dateTo = input.events.reduce((latest, event) => {
    const eventEnd = event.dateTo ?? event.dateFrom;
    return eventEnd > latest ? eventEnd : latest;
  }, input.events[0]?.dateTo ?? input.events[0]?.dateFrom ?? '');

  return database.transaction().execute(async (transaction) => {
    const now = new Date();
    const insertion = await transaction
      .insertInto('events')
      .values(
        input.events.map((event) => ({
          user_id: createdByUserId,
          calendar_id: calendarId,
          title: event.title,
          description: event.description,
          date_from: event.dateFrom,
          date_to: event.dateTo,
          time: event.time,
          status: 'active' as const,
          updated_at: now,
        })),
      )
      .executeTakeFirstOrThrow();

    if (insertion.insertId === undefined) {
      throw new Error('Database did not return the first created event id');
    }

    const firstEventId = Number(insertion.insertId);
    const insertedCount = Number(insertion.numInsertedOrUpdatedRows);
    const lastEventId = firstEventId + input.events.length - 1;

    if (
      !Number.isSafeInteger(firstEventId) ||
      !Number.isSafeInteger(lastEventId) ||
      insertedCount !== input.events.length
    ) {
      throw new Error('Database returned an invalid bulk event insertion result');
    }

    const rows = await transaction
      .selectFrom('events')
      .selectAll()
      .where('calendar_id', '=', calendarId)
      .where('id', '>=', firstEventId)
      .where('id', '<=', lastEventId)
      .orderBy('id', 'asc')
      .execute();

    if (
      rows.length !== input.events.length ||
      rows.some((row, index) => Number(row.id) !== firstEventId + index)
    ) {
      throw new Error('Database did not return the complete created event batch');
    }

    const events = rows.map((row) => eventSchema.parse(mapEvent(row)));

    return createEventsOutputSchema.parse({
      createdCount: events.length,
      dateRange: { from: dateFrom, to: dateTo },
      events,
    });
  });
}
