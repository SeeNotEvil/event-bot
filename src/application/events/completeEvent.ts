import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { cancelPendingEventNotifications } from '../notifications/cancelEventNotifications.js';
import { mapEvent } from './mapEvent.js';
import {
  completeEventInputSchema,
  completeEventOutputSchema,
  type CompleteEventInput,
  type CompleteEventOutput,
} from './schemas.js';

export async function completeEvent(
  database: Kysely<Database>,
  calendarId: number,
  rawInput: CompleteEventInput,
  now = new Date(),
): Promise<CompleteEventOutput> {
  const input = completeEventInputSchema.parse(rawInput);

  return database.transaction().execute(async (transaction) => {
    const event = await transaction
      .selectFrom('events')
      .selectAll()
      .where('id', '=', input.eventId)
      .where('calendar_id', '=', calendarId)
      .where('status', 'in', ['active', 'completed'])
      .forUpdate()
      .executeTakeFirst();

    if (!event) {
      return completeEventOutputSchema.parse({
        success: false,
        changed: false,
        event: null,
        cancelledNotificationCount: 0,
        reason: 'EVENT_NOT_FOUND_OR_NOT_COMPLETABLE',
      });
    }

    if (event.status === 'completed') {
      return completeEventOutputSchema.parse({
        success: true,
        changed: false,
        event: mapEvent(event),
        cancelledNotificationCount: 0,
      });
    }

    const update = await transaction
      .updateTable('events')
      .set({
        status: 'completed',
        completed_at: now,
        updated_at: now,
      })
      .where('id', '=', input.eventId)
      .where('calendar_id', '=', calendarId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();

    if (Number(update.numUpdatedRows) !== 1) {
      throw new Error('Event completion updated an unexpected number of rows');
    }

    const cancelledNotificationCount = await cancelPendingEventNotifications(
      transaction,
      [input.eventId],
      now,
    );
    const completedEvent = await transaction
      .selectFrom('events')
      .selectAll()
      .where('id', '=', input.eventId)
      .where('calendar_id', '=', calendarId)
      .executeTakeFirstOrThrow();

    return completeEventOutputSchema.parse({
      success: true,
      changed: true,
      event: mapEvent(completedEvent),
      cancelledNotificationCount,
    });
  });
}
