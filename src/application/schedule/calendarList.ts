import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { AgentContext } from '../../types/domain.js';
import type { TelegramGateway } from '../../telegram/TelegramAdapter.js';
import { mapEvent } from '../events/mapEvent.js';
import { formatDateForDatabase } from '../notifications/time.js';

export const LIST_PAGE_SIZE = 5;

export class StaleAgentTask extends Error {
  public constructor() { super('The task or calendar snapshot is no longer current'); }
}

export async function touchCalendarList(database: Kysely<Database>, calendarId: number): Promise<void> {
  await database.insertInto('calendar_lists').values({ calendar_id: calendarId })
    .onDuplicateKeyUpdate({ revision: sql`revision + 1`, page: 1, retry_at: null }).execute();
}

export async function requestListPage(
  database: Kysely<Database>, calendarId: number, messageId: number, page: number,
): Promise<void> {
  if (!Number.isSafeInteger(page) || page < 1) return;
  const count = await database.selectFrom('events').select(database.fn.countAll().as('count'))
    .where('calendar_id', '=', calendarId).where('status', '=', 'active').executeTakeFirstOrThrow();
  const pageCount = Math.max(1, Math.ceil(Number(count.count) / LIST_PAGE_SIZE));
  await database.updateTable('calendar_lists')
    .set({ page: Math.min(page, pageCount), revision: sql`revision + 1`, retry_at: null })
    .where('calendar_id', '=', calendarId).where('message_id', '=', messageId).execute();
}

export async function readTaskList(database: Kysely<Database>, calendarId: number) {
  await database.insertInto('calendar_lists').values({ calendar_id: calendarId })
    .onDuplicateKeyUpdate({ calendar_id: calendarId }).execute();
  return database.transaction().execute(async (transaction) => {
    const state = await transaction.selectFrom('calendar_lists').selectAll()
      .where('calendar_id', '=', calendarId).executeTakeFirstOrThrow();
    const count = await transaction.selectFrom('events').select(transaction.fn.countAll().as('count'))
      .where('calendar_id', '=', calendarId).where('status', '=', 'active').executeTakeFirstOrThrow();
    const total = Number(count.count);
    const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const page = Math.min(Number(state.page), pageCount);
    const rows = await transaction.selectFrom('events').innerJoin('users', 'users.id', 'events.user_id')
      .selectAll('events').select('users.first_name as author')
      .where('events.calendar_id', '=', calendarId).where('events.status', '=', 'active')
      .orderBy(sql`events.date_from is null`, 'asc')
      .orderBy(sql`coalesce(events.date_to, events.date_from)`, 'asc')
      .orderBy(sql`coalesce(events.time, '23:59:59')`, 'asc').orderBy('events.id', 'asc')
      .limit(LIST_PAGE_SIZE).offset((page - 1) * LIST_PAGE_SIZE).execute();
    return {
      revision: Number(state.revision), page, pageCount, total,
      events: rows.map((row) => ({ ...mapEvent(row), createdByName: row.author ?? 'Пользователь' })),
    };
  });
}

export async function claimCalendarList(database: Kysely<Database>, lockTimeoutMs: number, calendarId?: number) {
  return database.transaction().execute(async (transaction) => {
    let query = transaction.selectFrom('calendar_lists').selectAll()
      .where((eb) => eb.or([eb('locked_at', 'is', null), eb('locked_at', '<', formatDateForDatabase(new Date(Date.now() - lockTimeoutMs)))]))
      .where((eb) => eb.or([eb('retry_at', 'is', null), eb('retry_at', '<=', formatDateForDatabase(new Date()))]));
    if (calendarId !== undefined) {
      // An explicit list request may refresh an already published page.
      query = query.where('calendar_id', '=', calendarId);
    } else {
      query = query.where((eb) => eb.or([
        eb('revision', '!=', eb.ref('published_revision')),
        eb('page', '!=', eb.ref('published_page')),
      ]));
    }
    const state = await query.orderBy('calendar_id').forUpdate().skipLocked().executeTakeFirst();
    if (!state) return undefined;
    const token = randomUUID();
    await transaction.updateTable('calendar_lists').set({ lock_token: token, locked_at: new Date() })
      .where('calendar_id', '=', state.calendar_id).execute();
    return { ...state, token };
  });
}

export async function renewListClaim(
  database: Kysely<Database>, calendarId: number, token: string, revision: number,
): Promise<void> {
  const result = await database.updateTable('calendar_lists').set({ locked_at: new Date() })
    .where('calendar_id', '=', calendarId).where('lock_token', '=', token).where('revision', '=', revision).executeTakeFirstOrThrow();
  if (Number(result.numUpdatedRows) !== 1) throw new StaleAgentTask();
}

export async function releaseListClaim(database: Kysely<Database>, calendarId: number, token: string, failed: boolean): Promise<void> {
  await database.updateTable('calendar_lists').set({
    lock_token: null, locked_at: null,
    retry_at: failed ? new Date(Date.now() + 30_000) : null,
    last_error: failed ? 'Agent list publication failed' : null,
  }).where('calendar_id', '=', calendarId).where('lock_token', '=', token).execute();
}

export async function publishCalendarList(database: Kysely<Database>, telegram: TelegramGateway, context: AgentContext, text: string) {
  const snapshot = context.listSnapshot;
  if (!snapshot) throw new Error('Call read_task_list before send_event_list');
  const claim = context.listClaimToken
    ? { token: context.listClaimToken }
    : await claimCalendarList(database, 60_000, context.calendarId);
  if (!claim) throw new Error('Another run is publishing this list or publication is waiting for retry');
  try {
    await renewListClaim(database, context.calendarId, claim.token, snapshot.revision);
    const state = await database.selectFrom('calendar_lists').selectAll()
      .where('calendar_id', '=', context.calendarId).executeTakeFirstOrThrow();
    if (Number(state.page) !== snapshot.page || Number(state.revision) !== snapshot.revision) throw new StaleAgentTask();
    const buttons = [];
    if (snapshot.page > 1) buttons.push({ text: '‹', callback_data: `list:${snapshot.page - 1}` });
    if (snapshot.page < snapshot.pageCount) buttons.push({ text: '›', callback_data: `list:${snapshot.page + 1}` });
    const options = { reply_markup: { inline_keyboard: buttons.length ? [buttons] : [] } };
    let messageId = state.message_id === null ? null : Number(state.message_id);
    if (messageId !== null) {
      try {
        await telegram.editText(context.telegramChatId, messageId, text, options);
      } catch (error) {
        // Only a deleted/uneditable message requires replacement, not a network error.
        if (!(error instanceof Error) || !/message to edit not found|message can't be edited/i.test(error.message)) throw error;
        messageId = null;
      }
    }
    if (messageId === null) messageId = await telegram.sendText(context.telegramChatId, text, options);
    await database.updateTable('calendar_lists').set({
      message_id: messageId, published_revision: snapshot.revision, published_page: snapshot.page,
      lock_token: null, locked_at: null, retry_at: null, last_error: null,
    }).where('calendar_id', '=', context.calendarId).where('lock_token', '=', claim.token).execute();
    return messageId;
  } catch (error) {
    await releaseListClaim(database, context.calendarId, claim.token, !(error instanceof StaleAgentTask));
    throw error;
  }
}
