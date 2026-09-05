import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendMessage, getRecentMessages } from '../../src/application/conversations/conversationHistory.js';
import { completeEvent } from '../../src/application/events/completeEvent.js';
import { createEvent } from '../../src/application/events/createEvent.js';
import { createEvents } from '../../src/application/events/createEvents.js';
import { deleteEvent } from '../../src/application/events/deleteEvent.js';
import { deleteEvents } from '../../src/application/events/deleteEvents.js';
import { rescheduleEvent } from '../../src/application/events/rescheduleEvent.js';
import { searchEvents } from '../../src/application/events/searchEvents.js';
import { createNotification } from '../../src/application/notifications/createNotification.js';
import { deleteNotification } from '../../src/application/notifications/deleteNotification.js';
import { processDueNotifications } from '../../src/application/notifications/processDueNotifications.js';
import { searchNotifications } from '../../src/application/notifications/searchNotifications.js';
import { searchSchedule } from '../../src/application/schedule/searchSchedule.js';
import { ensureUser } from '../../src/application/users/ensureUser.js';
import {
  getUserPreferences,
  saveUserPreferences,
} from '../../src/application/users/userPreferences.js';
import { createDatabase } from '../../src/db/connection.js';
import { migrateToLatest } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';

const describeWithMysql = process.env.RUN_MYSQL_TESTS === '1' ? describe : describe.skip;

describeWithMysql('MySQL application actions', () => {
  let database: Kysely<Database>;

  beforeAll(async () => {
    database = createDatabase({
      host: process.env.TEST_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.TEST_MYSQL_PORT ?? 3306),
      database: process.env.TEST_MYSQL_DATABASE ?? 'telegram_event_bot',
      user: process.env.TEST_MYSQL_USER ?? 'telegram_event_bot',
      password: process.env.TEST_MYSQL_PASSWORD ?? 'change-me',
    });
    await migrateToLatest(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  it('creates an ordered batch of 100 events and writes nothing for an invalid batch', async () => {
    const unique = Date.now();
    const owner = await ensureUser(database, {
      telegramUserId: unique,
      telegramChatId: unique,
      telegramUsername: `batch_${unique}`,
      firstName: 'Пакет',
      lastName: null,
      defaultTimezone: 'Europe/Moscow',
    });

    try {
      const inputEvents = Array.from({ length: 100 }, (_, index) => ({
        title: `Пакетное событие ${index + 1}`,
        description: null,
        dateFrom: '2035-09-12',
        dateTo: index === 99 ? '2035-09-15' : null,
        time: null,
      }));
      const created = await createEvents(database, owner.id, { events: inputEvents });

      expect(created).toMatchObject({
        createdCount: 100,
        dateRange: { from: '2035-09-12', to: '2035-09-15' },
      });
      expect(created.events.map((event) => event.title)).toEqual(
        inputEvents.map((event) => event.title),
      );
      expect(new Set(created.events.map((event) => event.id)).size).toBe(100);

      const countBeforeRejectedBatch = await database
        .selectFrom('events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('user_id', '=', owner.id)
        .executeTakeFirstOrThrow();

      await expect(
        createEvents(database, owner.id, {
          events: [inputEvents[0]!, { ...inputEvents[1]!, title: '' }],
        }),
      ).rejects.toThrow();

      const countAfterRejectedBatch = await database
        .selectFrom('events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('user_id', '=', owner.id)
        .executeTakeFirstOrThrow();
      expect(Number(countAfterRejectedBatch.count)).toBe(Number(countBeforeRejectedBatch.count));
    } finally {
      await database.deleteFrom('users').where('id', '=', owner.id).execute();
    }
  });

  it('isolates users, searches ranges, soft-deletes, and prunes history', async () => {
    const unique = Date.now();
    const firstUser = await ensureUser(database, {
      telegramUserId: unique,
      telegramChatId: unique,
      telegramUsername: `ivan_${unique}`,
      firstName: 'Иван',
      lastName: 'Петров',
      defaultTimezone: 'Europe/Moscow',
    });
    const secondUser = await ensureUser(database, {
      telegramUserId: unique + 1,
      telegramChatId: unique + 1,
      telegramUsername: null,
      firstName: 'Мария',
      lastName: null,
      defaultTimezone: 'Europe/Moscow',
    });

    try {
      const existingUser = await ensureUser(database, {
        telegramUserId: unique,
        telegramChatId: unique + 10,
        telegramUsername: `ivan_updated_${unique}`,
        firstName: 'Иван',
        lastName: 'Обновлённый',
        defaultTimezone: 'UTC',
      });
      expect(existingUser.id).toBe(firstUser.id);
      expect(existingUser.telegramChatId).toBe(unique + 10);
      expect(existingUser.telegramUsername).toBe(`ivan_updated_${unique}`);
      expect(existingUser.firstName).toBe('Иван');
      expect(existingUser.lastName).toBe('Обновлённый');
      expect(existingUser.displayName).toBe('Иван Обновлённый');
      expect(existingUser.timezone).toBe('Europe/Moscow');

      expect(await getUserPreferences(database, firstUser.id)).toBeNull();
      await expect(
        saveUserPreferences(database, firstUser.id, {
          preferences: 'Обращение: Капитан.\nСтиль: кратко.',
        }),
      ).resolves.toEqual({
        success: true,
        preferences: 'Обращение: Капитан.\nСтиль: кратко.',
      });
      expect(await getUserPreferences(database, secondUser.id)).toBeNull();

      await saveUserPreferences(database, firstUser.id, {
        preferences: 'Обращение: Шеф.\nСтиль: кратко.',
      });
      expect(await getUserPreferences(database, firstUser.id)).toBe(
        'Обращение: Шеф.\nСтиль: кратко.',
      );

      await saveUserPreferences(database, firstUser.id, { preferences: null });
      expect(await getUserPreferences(database, firstUser.id)).toBeNull();

      const dentist = await createEvent(database, firstUser.id, {
        title: 'Стоматолог',
        description: 'Плановый осмотр',
        dateFrom: '2035-09-12',
        dateTo: null,
        time: '18:00',
      });
      const documents = await createEvent(database, firstUser.id, {
        title: 'Забрать документы',
        description: null,
        dateFrom: '2035-09-10',
        dateTo: '2035-09-15',
        time: null,
      });
      const groceries = await createEvent(database, firstUser.id, {
        title: 'Купить продукты',
        description: null,
        dateFrom: '2035-09-16',
        dateTo: null,
        time: '20:00',
      });
      const foreignEvent = await createEvent(database, secondUser.id, {
        title: 'Стоматолог другого пользователя',
        description: null,
        dateFrom: '2035-09-12',
        dateTo: null,
        time: null,
      });
      const reschedulable = await createEvent(database, firstUser.id, {
        title: 'Учебный курс',
        description: 'С сохранением описания',
        dateFrom: '2035-10-10',
        dateTo: '2035-10-12',
        time: '18:00',
      });

      const textSearch = await searchEvents(database, firstUser.id, {
        query: 'СТОМАТОЛОГ',
        statuses: ['active'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(textSearch.events).toHaveLength(1);
      expect(textSearch.events[0]?.id).toBe(dentist.id);

      const oldCourseReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: reschedulable.id, remindAt: '2035-10-08T10:00' },
      );
      const secondOldCourseReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: reschedulable.id, remindAt: '2035-10-09T10:00' },
      );
      expect(oldCourseReminder.success).toBe(true);
      expect(secondOldCourseReminder.success).toBe(true);
      if (!oldCourseReminder.success || !secondOldCourseReminder.success) {
        throw new Error('Expected course reminders to be created');
      }

      await expect(
        rescheduleEvent(
          database,
          secondUser.id,
          secondUser.timezone,
          '2035-09-05T09:00:00+03:00',
          {
            eventId: reschedulable.id,
            dateFrom: '2035-10-20',
            dateTo: '2035-10-22',
            time: '18:00',
            reminderTimes: [],
          },
        ),
      ).resolves.toMatchObject({
        success: false,
        changed: false,
        reason: 'EVENT_NOT_FOUND_OR_INACTIVE',
      });

      await expect(
        rescheduleEvent(
          database,
          firstUser.id,
          firstUser.timezone,
          '2035-09-05T09:00:00+03:00',
          {
            eventId: reschedulable.id,
            dateFrom: '2035-10-20',
            dateTo: '2035-10-22',
            time: '18:00',
            reminderTimes: ['2035-09-05T08:59'],
          },
        ),
      ).resolves.toMatchObject({
        success: false,
        changed: false,
        reason: 'REMINDER_NOT_IN_FUTURE',
      });

      const courseAfterRejectedMove = await searchEvents(database, firstUser.id, {
        query: 'Учебный курс',
        statuses: ['active'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(courseAfterRejectedMove.events[0]).toMatchObject({
        id: reschedulable.id,
        dateFrom: '2035-10-10',
        dateTo: '2035-10-12',
        time: '18:00',
      });

      const replacementTimes = ['2035-10-18T10:00', '2035-10-19T10:00'];
      const movedCourse = await rescheduleEvent(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-05T09:00:00+03:00',
        {
          eventId: reschedulable.id,
          dateFrom: '2035-10-20',
          dateTo: '2035-10-22',
          time: '18:00',
          reminderTimes: replacementTimes,
        },
      );
      expect(movedCourse).toMatchObject({
        success: true,
        changed: true,
        event: {
          id: reschedulable.id,
          title: 'Учебный курс',
          description: 'С сохранением описания',
          dateFrom: '2035-10-20',
          dateTo: '2035-10-22',
          time: '18:00',
          status: 'active',
        },
        cancelledNotificationCount: 2,
      });
      if (!movedCourse.success) {
        throw new Error('Expected course reschedule to succeed');
      }
      expect(movedCourse.notifications.map((notification) => notification.remindAt)).toEqual(
        replacementTimes,
      );

      const cancelledOldCourseReminders = await searchNotifications(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          eventId: reschedulable.id,
          statuses: ['cancelled'],
          remindFrom: null,
          remindTo: null,
          limit: null,
        },
      );
      expect(cancelledOldCourseReminders.notifications.map((notification) => notification.id))
        .toEqual(expect.arrayContaining([
          oldCourseReminder.notification.id,
          secondOldCourseReminder.notification.id,
        ]));

      const repeatedCourseMove = await rescheduleEvent(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-05T09:00:00+03:00',
        {
          eventId: reschedulable.id,
          dateFrom: '2035-10-20',
          dateTo: '2035-10-22',
          time: '18:00',
          reminderTimes: replacementTimes,
        },
      );
      expect(repeatedCourseMove).toMatchObject({
        success: true,
        changed: false,
        cancelledNotificationCount: 0,
      });
      if (!repeatedCourseMove.success) {
        throw new Error('Expected repeated course reschedule to succeed');
      }
      expect(repeatedCourseMove.notifications.map((notification) => notification.id)).toEqual(
        movedCourse.notifications.map((notification) => notification.id),
      );

      await expect(
        rescheduleEvent(
          database,
          firstUser.id,
          firstUser.timezone,
          '2035-09-05T09:00:00+03:00',
          {
            eventId: reschedulable.id,
            dateFrom: '2035-10-21',
            dateTo: '2035-10-23',
            time: '18:00',
            reminderTimes: [],
          },
        ),
      ).resolves.toMatchObject({
        success: true,
        changed: true,
        notifications: [],
        cancelledNotificationCount: 2,
      });

      const firstReminderResult = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: dentist.id, remindAt: '2035-09-05T10:00' },
      );
      expect(firstReminderResult).toMatchObject({ success: true, created: true });
      if (!firstReminderResult.success) {
        throw new Error('Expected the first reminder to be created');
      }

      const secondReminderResult = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: dentist.id, remindAt: '2035-09-06T10:00' },
      );
      expect(secondReminderResult).toMatchObject({ success: true, created: true });
      if (!secondReminderResult.success) {
        throw new Error('Expected the second reminder to be created');
      }

      const duplicateReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: dentist.id, remindAt: '2035-09-05T10:00' },
      );
      expect(duplicateReminder).toMatchObject({
        success: true,
        created: false,
        notification: { id: firstReminderResult.notification.id },
      });

      await expect(
        createNotification(
          database,
          firstUser.id,
          firstUser.timezone,
          '2035-09-04T12:00:00+03:00',
          { eventId: foreignEvent.id, remindAt: '2035-09-05T11:00' },
        ),
      ).resolves.toMatchObject({ success: false, reason: 'EVENT_NOT_FOUND_OR_INACTIVE' });

      await expect(
        createNotification(
          database,
          firstUser.id,
          firstUser.timezone,
          '2035-09-04T12:00:00+03:00',
          { eventId: dentist.id, remindAt: '2035-09-04T11:59' },
        ),
      ).resolves.toMatchObject({ success: false, reason: 'REMINDER_NOT_IN_FUTURE' });

      const reminders = await searchNotifications(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          eventId: dentist.id,
          statuses: ['pending'],
          remindFrom: null,
          remindTo: null,
          limit: null,
        },
      );
      expect(reminders.notifications.map((notification) => notification.remindAt)).toEqual([
        '2035-09-05T10:00',
        '2035-09-06T10:00',
      ]);

      const eventsOnDentistDate = await searchSchedule(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          query: null,
          eventStatuses: null,
          eventDateFrom: '2035-09-12',
          eventDateTo: '2035-09-12',
          reminderStatuses: null,
          reminderFrom: null,
          reminderTo: null,
          requireReminder: false,
          limit: null,
        },
      );
      expect(eventsOnDentistDate.events.map((event) => event.title)).toEqual([
        'Забрать документы',
        'Стоматолог',
      ]);
      expect(
        eventsOnDentistDate.events.find((event) => event.id === documents.id)?.notifications,
      ).toEqual([]);
      expect(
        eventsOnDentistDate.events
          .find((event) => event.id === dentist.id)
          ?.notifications.map((notification) => notification.remindAt),
      ).toEqual(['2035-09-05T10:00', '2035-09-06T10:00']);
      expect(eventsOnDentistDate.events.some((event) => event.id === foreignEvent.id)).toBe(false);

      const remindersOnSeptemberSixth = await searchSchedule(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          query: null,
          eventStatuses: ['active'],
          eventDateFrom: null,
          eventDateTo: null,
          reminderStatuses: ['pending'],
          reminderFrom: '2035-09-06T00:00',
          reminderTo: '2035-09-06T23:59',
          requireReminder: true,
          limit: null,
        },
      );
      expect(remindersOnSeptemberSixth.events).toHaveLength(1);
      expect(remindersOnSeptemberSixth.events[0]).toMatchObject({
        id: dentist.id,
        notifications: [
          {
            id: secondReminderResult.notification.id,
            remindAt: '2035-09-06T10:00',
            status: 'pending',
          },
        ],
      });

      const allActiveSchedule = await searchSchedule(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          query: null,
          eventStatuses: ['active'],
          eventDateFrom: null,
          eventDateTo: null,
          reminderStatuses: ['pending'],
          reminderFrom: null,
          reminderTo: null,
          requireReminder: false,
          limit: null,
        },
      );
      expect(allActiveSchedule.events.map((event) => event.id)).toEqual(
        expect.arrayContaining([dentist.id, documents.id, groceries.id, reschedulable.id]),
      );
      expect(allActiveSchedule.events.some((event) => event.id === foreignEvent.id)).toBe(false);

      await expect(
        deleteNotification(database, secondUser.id, {
          notificationId: secondReminderResult.notification.id,
        }),
      ).resolves.toMatchObject({ success: false, reason: 'NOT_FOUND_OR_NOT_PENDING' });

      await expect(
        deleteNotification(database, firstUser.id, {
          notificationId: secondReminderResult.notification.id,
        }),
      ).resolves.toMatchObject({
        success: true,
        notification: { status: 'cancelled' },
      });

      const reactivatedReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: dentist.id, remindAt: '2035-09-06T10:00' },
      );
      expect(reactivatedReminder).toMatchObject({
        success: true,
        created: true,
        notification: {
          id: secondReminderResult.notification.id,
          status: 'pending',
        },
      });

      const failedDelivery = vi.fn(async () => {
        throw new Error('Temporary Telegram failure');
      });
      await expect(
        processDueNotifications(database, {
          now: new Date('2035-09-05T07:30:00.000Z'),
          batchSize: 10,
          lockTimeoutMs: 60_000,
          notificationIds: [firstReminderResult.notification.id],
          send: failedDelivery,
        }),
      ).resolves.toEqual({ claimed: 1, sent: 0, failed: 1, skipped: 0 });

      const failedRow = await database
        .selectFrom('notifications')
        .select(['attempts', 'lock_token', 'last_error', 'status'])
        .where('id', '=', firstReminderResult.notification.id)
        .executeTakeFirstOrThrow();
      expect(failedRow).toMatchObject({
        attempts: 1,
        lock_token: null,
        status: 'pending',
      });
      expect(failedRow.last_error).toContain('Temporary Telegram failure');

      const delivered = vi.fn(async () => undefined);
      await expect(
        processDueNotifications(database, {
          now: new Date('2035-09-05T07:31:00.000Z'),
          batchSize: 10,
          lockTimeoutMs: 60_000,
          notificationIds: [firstReminderResult.notification.id],
          send: delivered,
        }),
      ).resolves.toEqual({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
      expect(delivered).toHaveBeenCalledWith(
        expect.objectContaining({
          notificationId: firstReminderResult.notification.id,
          eventId: dentist.id,
          telegramChatId: existingUser.telegramChatId,
          firstName: 'Иван',
          timezone: 'Europe/Moscow',
        }),
      );

      await expect(
        processDueNotifications(database, {
          now: new Date('2035-09-05T07:32:00.000Z'),
          batchSize: 10,
          lockTimeoutMs: 60_000,
          notificationIds: [firstReminderResult.notification.id],
          send: delivered,
        }),
      ).resolves.toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
      await expect(
        deleteNotification(database, firstUser.id, {
          notificationId: firstReminderResult.notification.id,
        }),
      ).resolves.toMatchObject({ success: false, reason: 'NOT_FOUND_OR_NOT_PENDING' });

      const overlap = await searchEvents(database, firstUser.id, {
        query: null,
        statuses: ['active'],
        dateFrom: '2035-09-14',
        dateTo: '2035-09-14',
        limit: null,
      });
      expect(overlap.events.map((event) => event.title)).toEqual(['Забрать документы']);

      expect(await deleteEvent(database, secondUser.id, { eventId: dentist.id })).toEqual({
        success: false,
        event: null,
        reason: 'NOT_FOUND_OR_INACTIVE',
      });
      expect(await deleteEvent(database, firstUser.id, { eventId: dentist.id })).toMatchObject({
        success: true,
        event: { id: dentist.id, status: 'deleted' },
      });

      const cancelledByEventDeletion = await searchNotifications(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          eventId: dentist.id,
          statuses: ['cancelled'],
          remindFrom: null,
          remindTo: null,
          limit: null,
        },
      );
      expect(cancelledByEventDeletion.notifications.map((notification) => notification.id)).toContain(
        secondReminderResult.notification.id,
      );
      expect(await deleteEvent(database, firstUser.id, { eventId: dentist.id })).toMatchObject({
        success: false,
      });

      const documentsReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: documents.id, remindAt: '2035-09-09T10:00' },
      );
      const groceriesReminder = await createNotification(
        database,
        firstUser.id,
        firstUser.timezone,
        '2035-09-04T12:00:00+03:00',
        { eventId: groceries.id, remindAt: '2035-09-15T10:00' },
      );
      expect(documentsReminder.success).toBe(true);
      expect(groceriesReminder.success).toBe(true);

      expect(
        await deleteEvents(database, firstUser.id, {
          eventIds: [documents.id, foreignEvent.id],
        }),
      ).toEqual({
        success: false,
        deletedCount: 0,
        events: [],
        reason: 'NOT_FOUND_OR_INACTIVE',
        missingEventIds: [foreignEvent.id],
      });

      const documentsAfterFailedBatch = await searchEvents(database, firstUser.id, {
        query: 'Забрать документы',
        statuses: ['active'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(documentsAfterFailedBatch.events).toHaveLength(1);

      const documentReminderAfterFailedBatch = await searchNotifications(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          eventId: documents.id,
          statuses: ['pending'],
          remindFrom: null,
          remindTo: null,
          limit: null,
        },
      );
      expect(documentReminderAfterFailedBatch.notifications).toHaveLength(1);

      expect(
        await deleteEvents(database, firstUser.id, {
          eventIds: [groceries.id, documents.id],
        }),
      ).toEqual({
        success: true,
        deletedCount: 2,
        events: [
          { id: groceries.id, title: 'Купить продукты', status: 'deleted' },
          { id: documents.id, title: 'Забрать документы', status: 'deleted' },
        ],
      });

      const cancelledByBulkDeletion = await searchNotifications(
        database,
        firstUser.id,
        firstUser.timezone,
        {
          eventId: null,
          statuses: ['cancelled'],
          remindFrom: null,
          remindTo: null,
          limit: 100,
        },
      );
      const cancelledIds = cancelledByBulkDeletion.notifications.map(
        (notification) => notification.id,
      );
      if (documentsReminder.success) {
        expect(cancelledIds).toContain(documentsReminder.notification.id);
      }
      if (groceriesReminder.success) {
        expect(cancelledIds).toContain(groceriesReminder.notification.id);
      }

      expect(
        await deleteEvents(database, firstUser.id, {
          eventIds: [groceries.id, documents.id],
        }),
      ).toMatchObject({
        success: false,
        deletedCount: 0,
        missingEventIds: [groceries.id, documents.id],
      });

      const foreignStillActive = await searchEvents(database, secondUser.id, {
        query: null,
        statuses: ['active'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(foreignStillActive.events.map((event) => event.id)).toContain(foreignEvent.id);

      for (let index = 0; index < 55; index += 1) {
        await appendMessage(
          database,
          firstUser.id,
          { role: index % 2 === 0 ? 'user' : 'assistant', content: `message-${index}` },
          50,
        );
      }
      const history = await getRecentMessages(database, firstUser.id, 50);
      expect(history).toHaveLength(50);
      expect(history[0]?.content).toBe('message-5');
      expect(history[49]?.content).toBe('message-54');
    } finally {
      await database.deleteFrom('users').where('id', 'in', [firstUser.id, secondUser.id]).execute();
    }
  });

  it('completes events idempotently, cancels reminders, and keeps completed events queryable', async () => {
    const unique = Date.now() + 10_000;
    const owner = await ensureUser(database, {
      telegramUserId: unique,
      telegramChatId: unique,
      telegramUsername: null,
      firstName: 'Ксюша',
      lastName: null,
      defaultTimezone: 'Europe/Moscow',
    });
    const otherUser = await ensureUser(database, {
      telegramUserId: unique + 1,
      telegramChatId: unique + 1,
      telegramUsername: null,
      firstName: 'Мария',
      lastName: null,
      defaultTimezone: 'Europe/Moscow',
    });

    try {
      const event = await createEvent(database, owner.id, {
        title: 'Подготовить отчёт',
        description: null,
        dateFrom: '2036-01-10',
        dateTo: null,
        time: '10:00',
      });
      expect(event.completedAt).toBeNull();

      const pendingReminder = await createNotification(
        database,
        owner.id,
        owner.timezone,
        '2035-12-01T10:00:00+03:00',
        { eventId: event.id, remindAt: '2036-01-09T09:00' },
      );
      const sentReminder = await createNotification(
        database,
        owner.id,
        owner.timezone,
        '2035-12-01T10:00:00+03:00',
        { eventId: event.id, remindAt: '2036-01-08T09:00' },
      );
      if (!pendingReminder.success || !sentReminder.success) {
        throw new Error('Expected completion-test reminders to be created');
      }

      await database
        .updateTable('notifications')
        .set({
          status: 'sent',
          sent_at: new Date('2036-01-08T06:00:00.000Z'),
          updated_at: new Date('2036-01-08T06:00:00.000Z'),
        })
        .where('id', '=', sentReminder.notification.id)
        .executeTakeFirstOrThrow();

      await expect(
        completeEvent(
          database,
          otherUser.id,
          { eventId: event.id },
          new Date('2035-12-20T12:34:56.789Z'),
        ),
      ).resolves.toEqual({
        success: false,
        changed: false,
        event: null,
        cancelledNotificationCount: 0,
        reason: 'EVENT_NOT_FOUND_OR_NOT_COMPLETABLE',
      });

      const completed = await completeEvent(
        database,
        owner.id,
        { eventId: event.id },
        new Date('2035-12-20T12:34:56.789Z'),
      );
      expect(completed).toMatchObject({
        success: true,
        changed: true,
        event: {
          id: event.id,
          title: 'Подготовить отчёт',
          status: 'completed',
          completedAt: '2035-12-20T12:34:56.789Z',
        },
        cancelledNotificationCount: 1,
      });

      await expect(
        completeEvent(
          database,
          owner.id,
          { eventId: event.id },
          new Date('2035-12-21T00:00:00.000Z'),
        ),
      ).resolves.toMatchObject({
        success: true,
        changed: false,
        event: { completedAt: '2035-12-20T12:34:56.789Z' },
        cancelledNotificationCount: 0,
      });

      const remindersAfterCompletion = await searchNotifications(
        database,
        owner.id,
        owner.timezone,
        {
          eventId: event.id,
          statuses: ['sent', 'cancelled'],
          remindFrom: null,
          remindTo: null,
          limit: null,
        },
      );
      expect(remindersAfterCompletion.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: pendingReminder.notification.id,
            status: 'cancelled',
          }),
          expect.objectContaining({
            id: sentReminder.notification.id,
            status: 'sent',
          }),
        ]),
      );

      const send = vi.fn(async () => undefined);
      await expect(
        processDueNotifications(database, {
          now: new Date('2036-01-10T12:00:00.000Z'),
          batchSize: 10,
          lockTimeoutMs: 60_000,
          notificationIds: [pendingReminder.notification.id],
          send,
        }),
      ).resolves.toEqual({ claimed: 0, sent: 0, failed: 0, skipped: 0 });
      expect(send).not.toHaveBeenCalled();

      const activeSearch = await searchEvents(database, owner.id, {
        query: 'отчёт',
        statuses: ['active'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(activeSearch.events).toEqual([]);

      const completedSchedule = await searchSchedule(database, owner.id, owner.timezone, {
        query: 'отчёт',
        eventStatuses: ['completed'],
        eventDateFrom: null,
        eventDateTo: null,
        reminderStatuses: ['pending'],
        reminderFrom: null,
        reminderTo: null,
        requireReminder: false,
        limit: null,
      });
      expect(completedSchedule.events).toMatchObject([
        {
          id: event.id,
          status: 'completed',
          completedAt: '2035-12-20T12:34:56.789Z',
          notifications: [],
        },
      ]);

      const defaultSchedule = await searchSchedule(database, owner.id, owner.timezone, {
        query: 'отчёт',
        eventStatuses: null,
        eventDateFrom: null,
        eventDateTo: null,
        reminderStatuses: null,
        reminderFrom: null,
        reminderTo: null,
        requireReminder: false,
        limit: null,
      });
      expect(defaultSchedule.events).toEqual([]);

      await expect(
        createNotification(
          database,
          owner.id,
          owner.timezone,
          '2035-12-21T00:00:00+03:00',
          { eventId: event.id, remindAt: '2036-01-09T12:00' },
        ),
      ).resolves.toMatchObject({ success: false, reason: 'EVENT_NOT_FOUND_OR_INACTIVE' });
      await expect(
        rescheduleEvent(
          database,
          owner.id,
          owner.timezone,
          '2035-12-21T00:00:00+03:00',
          {
            eventId: event.id,
            dateFrom: '2036-01-11',
            dateTo: null,
            time: '10:00',
            reminderTimes: [],
          },
        ),
      ).resolves.toMatchObject({
        success: false,
        reason: 'EVENT_NOT_FOUND_OR_INACTIVE',
      });

      expect(await deleteEvent(database, owner.id, { eventId: event.id })).toMatchObject({
        success: true,
        event: { id: event.id, status: 'deleted' },
      });
      const deletedSearch = await searchEvents(database, owner.id, {
        query: 'отчёт',
        statuses: ['deleted'],
        dateFrom: null,
        dateTo: null,
        limit: null,
      });
      expect(deletedSearch.events[0]).toMatchObject({
        id: event.id,
        status: 'deleted',
        completedAt: '2035-12-20T12:34:56.789Z',
      });
      await expect(completeEvent(database, owner.id, { eventId: event.id })).resolves.toMatchObject({
        success: false,
        reason: 'EVENT_NOT_FOUND_OR_NOT_COMPLETABLE',
      });

      const activeForBulk = await createEvent(database, owner.id, {
        title: 'Активное для удаления',
        description: null,
        dateFrom: '2036-02-01',
        dateTo: null,
        time: null,
      });
      const completedForBulk = await createEvent(database, owner.id, {
        title: 'Выполненное для удаления',
        description: null,
        dateFrom: '2036-02-02',
        dateTo: null,
        time: null,
      });
      await completeEvent(
        database,
        owner.id,
        { eventId: completedForBulk.id },
        new Date('2035-12-22T00:00:00.000Z'),
      );
      await expect(
        deleteEvents(database, owner.id, {
          eventIds: [activeForBulk.id, completedForBulk.id],
        }),
      ).resolves.toMatchObject({ success: true, deletedCount: 2 });
    } finally {
      await database.deleteFrom('users').where('id', 'in', [owner.id, otherUser.id]).execute();
    }
  });
});
