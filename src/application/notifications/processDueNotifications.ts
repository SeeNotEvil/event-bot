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
};

type ClaimedNotification = DueNotification & {
  claimToken: string;
};

export type ProcessDueNotificationsOptions = {
  now: Date;
  batchSize: number;
  lockTimeoutMs: number;
  notificationIds?: number[];
  send: (notification: DueNotification) => Promise<void>;
};

export type ProcessDueNotificationsResult = {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
};

async function claimDueNotifications(
  database: Kysely<Database>,
  now: Date,
  batchSize: number,
  lockTimeoutMs: number,
  onlyNotificationIds?: number[],
): Promise<ClaimedNotification[]> {
  if (onlyNotificationIds?.length === 0) {
    return [];
  }

  const claimToken = randomUUID();
  const staleBefore = new Date(now.getTime() - lockTimeoutMs);
  const nowForDatabase = formatDateForDatabase(now);
  const staleBeforeForDatabase = formatDateForDatabase(staleBefore);

  return database.transaction().execute(async (transaction) => {
    let query = transaction
      .selectFrom('notifications')
      .innerJoin('events', 'events.id', 'notifications.event_id')
      .innerJoin('calendars', 'calendars.id', 'events.calendar_id')
      .innerJoin('users as event_creator', 'event_creator.id', 'events.user_id')
      .leftJoin('users as personal_owner', 'personal_owner.id', 'calendars.user_id')
      .select([
        'notifications.id as notification_id',
        'notifications.event_id',
        'notifications.timezone',
        'events.title as event_title',
        'events.date_from',
        'events.date_to',
        'events.time as event_time',
        sql<number | null>`case
          when calendars.type = 'group' then calendars.telegram_chat_id
          else personal_owner.telegram_chat_id
        end`.as('destination_chat_id'),
        'event_creator.first_name as creator_first_name',
      ])
      .where('notifications.status', '=', 'pending')
      .where('notifications.remind_at_utc', '<=', nowForDatabase)
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
      .limit(batchSize)
      .forUpdate()
      .skipLocked();

    if (onlyNotificationIds) {
      query = query.where('notifications.id', 'in', onlyNotificationIds);
    }

    const rows = await query.execute();

    const notificationIds = rows.map((row) => Number(row.notification_id));
    if (notificationIds.length === 0) {
      return [];
    }

    const update = await transaction
      .updateTable('notifications')
      .set({
        attempts: sql<number>`attempts + 1`,
        lock_token: claimToken,
        locked_at: now,
        updated_at: now,
      })
      .where('id', 'in', notificationIds)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    if (Number(update.numUpdatedRows) !== notificationIds.length) {
      throw new Error('Notification claim updated an unexpected number of rows');
    }

    return rows.map((row) => {
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
      };
    });
  });
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
  const notifications = await claimDueNotifications(
    database,
    options.now,
    options.batchSize,
    options.lockTimeoutMs,
    options.notificationIds,
  );
  const result: ProcessDueNotificationsResult = {
    claimed: notifications.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const notification of notifications) {
    try {
      await options.send(notification);
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
