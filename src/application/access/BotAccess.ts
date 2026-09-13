import { createHash } from 'node:crypto';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { AgentContext } from '../../types/domain.js';

export const telegramUserIdSchema = z.number().int().positive().safe();

export class AccessDeniedError extends Error {
  public constructor() { super('Access denied'); this.name = 'AccessDeniedError'; }
}

export type AccessPolicy = Pick<BotAccess, 'isAllowed' | 'isOwner'>;

export function isLiveRequest(context: AgentContext): boolean {
  return context.userId !== null && context.sourceMessageId !== undefined
    && context.trigger?.kind !== 'agent_task' && context.trigger?.kind !== 'notification'
    && context.trigger?.kind !== 'service';
}

export class BotAccess {
  public constructor(private readonly database: Kysely<Database>, public readonly ownerId: number) {
    telegramUserIdSchema.parse(ownerId);
  }

  public isOwner(telegramUserId: number | null): boolean { return telegramUserId === this.ownerId; }

  public async isAllowed(telegramUserId: number | null): Promise<boolean> {
    if (!telegramUserIdSchema.safeParse(telegramUserId).success) return false;
    if (this.isOwner(telegramUserId)) return true;
    return Boolean(await this.database.selectFrom('bot_access').select('telegram_user_id')
      .where('telegram_user_id', '=', telegramUserId!).executeTakeFirst());
  }

  public async requireAllowed(telegramUserId: number | null): Promise<void> {
    if (!await this.isAllowed(telegramUserId)) throw new AccessDeniedError();
  }

  /** The expression is a server-selected internal users.id, never an argument from the model. */
  public allowsUser(userId: RawBuilder<number | null>): RawBuilder<boolean> {
    return sql<boolean>`exists (select 1 from users access_user where access_user.id = ${userId}
      and (access_user.telegram_user_id = ${this.ownerId} or exists
        (select 1 from bot_access access_entry where access_entry.telegram_user_id = access_user.telegram_user_id)))`;
  }

  /** Summaries must be rebuilt when the owner or membership changes. */
  public async summaryKey(): Promise<string> {
    const rows = await this.database.selectFrom('bot_access').select('telegram_user_id').orderBy('telegram_user_id').execute();
    return createHash('sha256').update(JSON.stringify([this.ownerId, ...rows.map((row) => Number(row.telegram_user_id))])).digest('hex');
  }

  private requireOwner(actorId: number | null): void {
    if (!this.isOwner(actorId)) throw new AccessDeniedError();
  }

  public async list(actorId: number | null, afterId: number | null) {
    this.requireOwner(actorId);
    let query = this.database.selectFrom('bot_access').leftJoin('users', 'users.telegram_user_id', 'bot_access.telegram_user_id')
      .select(['bot_access.telegram_user_id', 'bot_access.added_by_telegram_user_id', 'bot_access.created_at',
        'users.first_name', 'users.last_name', 'users.telegram_username']);
    if (afterId !== null) query = query.where('bot_access.telegram_user_id', '>', telegramUserIdSchema.parse(afterId));
    const rows = await query.orderBy('bot_access.telegram_user_id').limit(51).execute();
    const users = rows.slice(0, 50).map((row) => ({ telegramUserId: Number(row.telegram_user_id),
      firstName: row.first_name, lastName: row.last_name, username: row.telegram_username,
      addedByTelegramUserId: Number(row.added_by_telegram_user_id), createdAt: row.created_at }));
    return { ownerTelegramUserId: this.ownerId, users, nextAfterId: rows.length > 50 ? users.at(-1)!.telegramUserId : null };
  }

  public async allow(actorId: number | null, targetId: number) {
    this.requireOwner(actorId);
    telegramUserIdSchema.parse(targetId);
    if (this.isOwner(targetId)) return { success: true, changed: false };
    const result = await this.database.insertInto('bot_access')
      .values({ telegram_user_id: targetId, added_by_telegram_user_id: this.ownerId })
      .ignore().executeTakeFirstOrThrow();
    return { success: true, changed: Number(result.numInsertedOrUpdatedRows) === 1 };
  }

  public async deny(actorId: number | null, targetId: number) {
    this.requireOwner(actorId);
    telegramUserIdSchema.parse(targetId);
    if (this.isOwner(targetId)) return { success: false, changed: false, reason: 'OWNER_PROTECTED' as const };
    return this.database.transaction().execute(async (transaction) => {
      const removed = await transaction.deleteFrom('bot_access').where('telegram_user_id', '=', targetId).executeTakeFirstOrThrow();
      const user = await transaction.selectFrom('users').select('id').where('telegram_user_id', '=', targetId).executeTakeFirst();
      if (user) {
        const now = new Date();
        await transaction.updateTable('schedules').set({ enabled: 0, version: sql<number>`version + 1`, updated_at: now })
          .where('created_by_user_id', '=', user.id).where('enabled', '=', 1).execute();
        await transaction.updateTable('notifications').set({ status: 'cancelled', version: sql<number>`version + 1`,
          lock_token: null, locked_at: null, retry_at: null, updated_at: now })
          .where('status', '=', 'pending').where((eb) => eb.or([
            eb('created_by_user_id', '=', user.id),
            eb.exists(eb.selectFrom('events').select('id').whereRef('events.id', '=', 'notifications.event_id')
              .where(sql<boolean>`coalesce(events.reminder_recipient_user_id, events.user_id) = ${user.id}`)),
          ])).execute();
      }
      return { success: true, changed: Number(removed.numDeletedRows) === 1, reason: null };
    });
  }
}
