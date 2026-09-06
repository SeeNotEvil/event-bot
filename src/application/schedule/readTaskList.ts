import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { mapEvent } from '../events/mapEvent.js';

const LIST_PAGE_SIZE = 5;

export async function readTaskList(database: Kysely<Database>, chatId: number, requestedPage = 1) {
  return database.transaction().execute(async (transaction) => {
    const count = await transaction.selectFrom('events').select(transaction.fn.countAll().as('count'))
      .where('chat_id', '=', chatId).where('status', '=', 'active').executeTakeFirstOrThrow();
    const total = Number(count.count);
    const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const page = Math.max(1, Math.min(requestedPage, pageCount));
    const rows = await transaction.selectFrom('events').innerJoin('users', 'users.id', 'events.user_id')
      .leftJoin('users as recipient', 'recipient.id', 'events.reminder_recipient_user_id')
      .selectAll('events').select(['users.first_name as author', 'recipient.first_name as recipient_name'])
      .where('events.chat_id', '=', chatId).where('events.status', '=', 'active')
      .orderBy(sql`events.date_from is null`, 'asc')
      .orderBy(sql`coalesce(events.date_to, events.date_from)`, 'asc')
      .orderBy(sql`coalesce(events.time, '23:59:59')`, 'asc').orderBy('events.id', 'asc')
      .limit(LIST_PAGE_SIZE).offset((page - 1) * LIST_PAGE_SIZE).execute();
    return {
      page, pageCount, total,
      events: rows.map((row) => ({ ...mapEvent(row), createdByName: row.author ?? 'Пользователь',
        reminderRecipientName: row.recipient_name ?? row.author ?? 'Пользователь' })),
    };
  });
}
