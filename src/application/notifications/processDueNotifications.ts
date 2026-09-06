import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { formatDateForDatabase } from './time.js';

export type DueNotification = {
  notificationId: number;
  eventId: number;
  eventTitle: string;
  eventDateFrom: string;
  eventDateTo: string | null;
  eventTime: string | null;
  telegramChatId: number;
  createdByName: string;
  timezone: string;
  calendarType: 'personal' | 'group';
  calendarTitle: string | null;
  recipientFirstName: string | null;
  recipientPreferences: string | null;
};

type ClaimedNotification = DueNotification & {
  claimToken: string;
};

export type ProcessDueNotificationsOptions = {
  now: Date;
  batchSize: number;
  lockTimeoutMs: number;
  notificationIds?: number[];
  signal?: AbortSignal;
  prepareMessage: (notification: DueNotification) => Promise<string>;
  send: (notification: DueNotification, message: string) => Promise<void>;
};

export type ProcessDueNotificationsResult = {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
};

async function claimDueNotification(
  database: Kysely<Database>,
  dueBefore: Date,
  lockTimeoutMs: number,
  processedIds: number[],
  onlyNotificationIds?: number[],
): Promise<ClaimedNotification | undefined> {
  if (onlyNotificationIds?.length === 0) {
    return undefined;
  }

  const claimToken = randomUUID();
  const staleBefore = new Date(Date.now() - lockTimeoutMs);
  const dueBeforeForDatabase = formatDateForDatabase(dueBefore);
  const staleBeforeForDatabase = formatDateForDatabase(staleBefore);

  return database.transaction().execute(async (transaction) => {
    let query = transaction
      .selectFrom('notifications')
      .innerJoin('events', 'events.id', 'notifications.event_id')
      .innerJoin('calendars', 'calendars.id', 'events.calendar_id')
      .innerJoin('users as event_creator', 'event_creator.id', 'events.user_id')
      .leftJoin('users as personal_owner', (join) =>
        join.onRef('personal_owner.id', '=', 'calendars.user_id').on('calendars.type', '=', 'personal'),
      )
      .leftJoin('user_preferences', 'user_preferences.user_id', 'personal_owner.id')
      .select([
        'notifications.id as notification_id',
        'notifications.event_id',
        'notifications.timezone',
        'events.title as event_title',
        'events.date_from',
        'events.date_to',
        'events.time as event_time',
        'calendars.type as calendar_type',
        'calendars.title as calendar_title',
        'personal_owner.first_name as recipient_first_name',
        'user_preferences.content as recipient_preferences',
        sql<number | null>`case
          when calendars.type = 'group' then calendars.telegram_chat_id
          else personal_owner.telegram_chat_id
        end`.as('destination_chat_id'),
        'event_creator.first_name as creator_first_name',
      ])
      .where('notifications.status', '=', 'pending')
      .where('notifications.remind_at_utc', '<=', dueBeforeForDatabase)
      .where('events.status', '=', 'active')
      .where((expression) =>
        expression.or([
          expression.and([
            expression('calendars.type', '=', 'group'),
            expression('calendars.telegram_chat_id', 'is not', null),
          ]),
          expression.and([
            expression('calendars.type', '=', 'personal'),
            expression('personal_owner.telegram_chat_id', 'is not', null),
          ]),
        ]),
      )
      .where((expression) =>
        expression.or([
          expression('notifications.locked_at', 'is', null),
          expression('notifications.locked_at', '<', staleBeforeForDatabase),
        ]),
      )
      .orderBy('notifications.remind_at_utc', 'asc')
      .orderBy('notifications.id', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked();

    if (onlyNotificationIds) {
      query = query.where('notifications.id', 'in', onlyNotificationIds);
    }
    if (processedIds.length > 0) {
      query = query.where('notifications.id', 'not in', processedIds);
    }

    const row = await query.executeTakeFirst();
    if (!row) {
      return undefined;
    }

    // The due cutoff belongs to the cycle; start this lease after acquiring the row.
    const now = new Date();
    const update = await transaction
      .updateTable('notifications')
      .set({
        attempts: sql<number>`attempts + 1`,
        lock_token: claimToken,
        locked_at: now,
        updated_at: now,
      })
      .where('id', '=', row.notification_id)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    if (Number(update.numUpdatedRows) !== 1) {
      throw new Error('Notification claim updated an unexpected number of rows');
    }

    if (row.destination_chat_id === null) {
      throw new Error('Claimed notification has no Telegram destination');
    }

    return {
      claimToken,
      notificationId: Number(row.notification_id),
      eventId: Number(row.event_id),
      eventTitle: row.event_title,
      eventDateFrom: row.date_from,
      eventDateTo: row.date_to,
      eventTime: row.event_time === null ? null : row.event_time.slice(0, 5),
      telegramChatId: Number(row.destination_chat_id),
      createdByName: row.creator_first_name ?? 'Пользователь',
      timezone: row.timezone,
      calendarType: row.calendar_type,
      calendarTitle: row.calendar_title,
      recipientFirstName: row.recipient_first_name,
      recipientPreferences: row.recipient_preferences,
    };
  });
}

async function refreshNotificationClaim(
  database: Kysely<Database>,
  notification: ClaimedNotification,
): Promise<boolean> {
  const now = new Date();
  // Check cancellation and ownership atomically, and reserve time for Telegram.
  const result = await database
    .updateTable('notifications')
    .set({ locked_at: now, updated_at: now })
    .where('id', '=', notification.notificationId)
    .where('status', '=', 'pending')
    .where('lock_token', '=', notification.claimToken)
    .where((expression) =>
      expression.exists(
        expression.selectFrom('events')
          .select('events.id')
          .whereRef('events.id', '=', 'notifications.event_id')
          .where('events.status', '=', 'active'),
      ),
    )
    .executeTakeFirstOrThrow();

  return Number(result.numUpdatedRows) === 1;
}

async function markNotificationSent(
  database: Kysely<Database>,
  notification: ClaimedNotification,
  now: Date,
): Promise<boolean> {
  const result = await database
    .updateTable('notifications')
    .set({
      status: 'sent',
      lock_token: null,
      locked_at: null,
      sent_at: now,
      last_error: null,
      updated_at: now,
    })
    .where('id', '=', notification.notificationId)
    .where('status', '=', 'pending')
    .where('lock_token', '=', notification.claimToken)
    .executeTakeFirstOrThrow();

  return Number(result.numUpdatedRows) === 1;
}

async function releaseFailedNotification(
  database: Kysely<Database>,
  notification: ClaimedNotification,
  now: Date,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : 'Unknown notification delivery error';

  await database
    .updateTable('notifications')
    .set({
      lock_token: null,
      locked_at: null,
      last_error: message.slice(0, 4_000),
      updated_at: now,
    })
    .where('id', '=', notification.notificationId)
    .where('status', '=', 'pending')
    .where('lock_token', '=', notification.claimToken)
    .executeTakeFirstOrThrow();
}

export async function processDueNotifications(
  database: Kysely<Database>,
  options: ProcessDueNotificationsOptions,
): Promise<ProcessDueNotificationsResult> {
  const processedIds: number[] = [];
  const result: ProcessDueNotificationsResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  while (result.claimed < options.batchSize && !options.signal?.aborted) {
    const notification = await claimDueNotification(
      database,
      options.now,
      options.lockTimeoutMs,
      processedIds,
      options.notificationIds,
    );
    if (!notification) {
      break;
    }
    processedIds.push(notification.notificationId);
    result.claimed += 1;

    try {
      const message = await options.prepareMessage(notification);
      if (!await refreshNotificationClaim(database, notification)) {
        result.skipped += 1;
        continue;
      }
      await options.send(notification, message);
    } catch (error) {
      await releaseFailedNotification(database, notification, new Date(), error);
      result.failed += 1;
      continue;
    }

    const markedSent = await markNotificationSent(database, notification, new Date());
    if (markedSent) {
      result.sent += 1;
    } else {
      result.skipped += 1;
    }
  }

  return result;
}
