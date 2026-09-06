import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { formatDateForDatabase } from './time.js';
import { StaleAgentTask } from '../schedule/chatList.js';

export type DueNotification = {
  notificationId: number;
  eventId: number;
  chatId: number;
  kind: 'reminder' | 'completion_check' | 'readiness_response';
  deadlineVersion: number;
  answer: boolean | null;
  eventTitle: string;
  eventDateFrom: string | null;
  eventDateTo: string | null;
  eventTime: string | null;
  telegramChatId: number;
  createdByName: string;
  createdByTelegramId: number;
  timezone: string;
  chatType: 'personal' | 'group';
  chatTitle: string | null;
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
  run: (notification: DueNotification, guard: () => Promise<void>) => Promise<void>;
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
      .innerJoin('chats', 'chats.id', 'events.chat_id')
      .innerJoin('users as event_creator', 'event_creator.id', 'events.user_id')
      .leftJoin('users as personal_owner', (join) =>
        join.onRef('personal_owner.id', '=', 'chats.user_id').on('chats.type', '=', 'personal'),
      )
      .leftJoin('memories as profile', (join) => join.onRef('profile.user_id', '=', 'personal_owner.id')
        .on('profile.namespace', '=', 'user').on('profile.memory_key', '=', 'profile'))
      .select([
        'notifications.id as notification_id',
        'notifications.event_id',
        'notifications.kind',
        'notifications.deadline_version',
        'notifications.answer',
        'notifications.timezone',
        'events.title as event_title',
        'events.date_from',
        'events.date_to',
        'events.time as event_time',
        'chats.type as chat_type',
        'chats.id as chat_id',
        'chats.title as chat_title',
        'personal_owner.first_name as recipient_first_name',
        'profile.content as recipient_preferences',
        sql<number | null>`case
          when chats.type = 'group' then chats.telegram_chat_id
          else personal_owner.telegram_chat_id
        end`.as('destination_chat_id'),
        'event_creator.first_name as creator_first_name',
        'event_creator.telegram_user_id as creator_telegram_id',
      ])
      .where('notifications.status', '=', 'pending')
      .where('notifications.remind_at_utc', '<=', dueBeforeForDatabase)
      .whereRef('events.deadline_version', '=', 'notifications.deadline_version')
      .where((eb) => eb.or([
        eb('events.status', '=', 'active'),
        eb.and([eb('events.status', '=', 'completed'), eb('notifications.kind', '=', 'readiness_response'), eb('notifications.action_applied', '=', 1)]),
      ]))
      .where((eb) => eb.or([eb('notifications.retry_at', 'is', null), eb('notifications.retry_at', '<=', formatDateForDatabase(new Date()))]))
      .where((expression) =>
        expression.or([
          expression.and([
            expression('chats.type', '=', 'group'),
            expression('chats.telegram_chat_id', 'is not', null),
          ]),
          expression.and([
            expression('chats.type', '=', 'personal'),
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
      chatId: Number(row.chat_id),
      kind: row.kind,
      deadlineVersion: Number(row.deadline_version),
      answer: row.answer === null ? null : Boolean(row.answer),
      eventTitle: row.event_title,
      eventDateFrom: row.date_from,
      eventDateTo: row.date_to,
      eventTime: row.event_time === null ? null : row.event_time.slice(0, 5),
      telegramChatId: Number(row.destination_chat_id),
      createdByName: row.creator_first_name ?? 'Пользователь',
      createdByTelegramId: Number(row.creator_telegram_id),
      timezone: row.timezone,
      chatType: row.chat_type,
      chatTitle: row.chat_title,
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
          .whereRef('events.deadline_version', '=', 'notifications.deadline_version')
          .where((eb) => eb.or([
            eb('events.status', '=', 'active'),
            eb.and([eb('events.status', '=', 'completed'), eb('notifications.kind', '=', 'readiness_response'), eb('notifications.action_applied', '=', 1)]),
          ])),
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
      retry_at: new Date(Date.now() + 30_000),
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
      const guard = async () => {
        if (options.signal?.aborted) throw new Error('Worker is stopping');
        if (!await refreshNotificationClaim(database, notification)) throw new StaleAgentTask();
      };
      await options.run(notification, guard);
    } catch (error) {
      if (error instanceof StaleAgentTask) {
        await database.updateTable('notifications').set({ status: 'cancelled', lock_token: null, locked_at: null })
          .where('id', '=', notification.notificationId).where('lock_token', '=', notification.claimToken).execute();
        result.skipped += 1;
        continue;
      }
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
