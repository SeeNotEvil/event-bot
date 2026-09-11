import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { AgentContext, ChatMemberReference } from '../../types/domain.js';
import type { TelegramMembershipGateway } from '../../telegram/TelegramAdapter.js';

export const chatMemberSchema = z.object({
  telegramUserId: z.number().int().positive().safe(), firstName: z.string(),
  lastName: z.string().nullable(), username: z.string().nullable(),
});
export type MembershipFailure = 'NOT_A_CHAT_MEMBER' | 'BOT_RECIPIENT_NOT_ALLOWED' | 'MEMBERSHIP_UNVERIFIED';

export async function checkChatMember(telegram: TelegramMembershipGateway, chatId: number, userId: number): Promise<
  { success: true; member: ChatMemberReference } | { success: false; reason: MembershipFailure }
> {
  try {
    const member = await telegram.getChatMember(chatId, userId);
    if (member.user.id !== userId) return { success: false, reason: 'MEMBERSHIP_UNVERIFIED' };
    if (member.user.is_bot) return { success: false, reason: 'BOT_RECIPIENT_NOT_ALLOWED' };
    if (!(member.status === 'creator' || member.status === 'administrator' || member.status === 'member'
      || (member.status === 'restricted' && member.is_member))) {
      return { success: false, reason: 'NOT_A_CHAT_MEMBER' };
    }
    return { success: true, member: { telegramUserId: member.user.id, firstName: member.user.first_name,
      lastName: member.user.last_name ?? null, username: member.user.username ?? null } };
  } catch {
    // An API failure is not evidence of membership. Never fall back to old history.
    return { success: false, reason: 'MEMBERSHIP_UNVERIFIED' };
  }
}

export class RecipientMembershipError extends Error {
  public constructor(public readonly reason: MembershipFailure) {
    super(`Cannot deliver to reminder recipient: ${reason}`);
  }
}

// Only intentional, actionable mention errors are exposed to the agent.
export class ChatMentionError extends Error {}

export async function requireChatMember(telegram: TelegramMembershipGateway, chatId: number, userId: number): Promise<void> {
  const result = await checkChatMember(telegram, chatId, userId);
  if (!result.success) throw new RecipientMembershipError(result.reason);
}

export async function searchChatMembers(database: Kysely<Database>, telegram: TelegramMembershipGateway,
  context: AgentContext, query: string | null) {
  const chat = await database.selectFrom('chats').selectAll().where('id', '=', context.chatId).executeTakeFirstOrThrow();
  let users = database.selectFrom('users').select(['id', 'telegram_user_id', 'first_name', 'last_name', 'telegram_username']);
  if (chat.type === 'personal') {
    users = users.where('id', '=', chat.user_id!);
  } else {
    // Only identities observed in this chat; private profiles never enter the candidate list.
    users = users.where((eb) => eb.or([
      eb.exists(eb.selectFrom('conversation_messages').innerJoin('threads', 'threads.id', 'conversation_messages.thread_id')
        .select('conversation_messages.id').whereRef('conversation_messages.user_id', '=', 'users.id').where('threads.chat_id', '=', chat.id)),
      eb.exists(eb.selectFrom('events').select('events.id').where('events.chat_id', '=', chat.id)
        .where((event) => event.or([event('events.user_id', '=', event.ref('users.id')),
          event('events.reminder_recipient_user_id', '=', event.ref('users.id'))]))),
    ]));
  }
  const term = query?.trim().replace(/^@/, '').toLocaleLowerCase() ?? '';
  if (term) {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    users = users.where((eb) => eb.or([eb('telegram_username', 'like', pattern),
      eb(sql<string>`concat_ws(' ', first_name, last_name)`, 'like', pattern)]));
  }
  const rows = await users.orderBy('id', 'desc').limit(11).execute();
  const references = (context.recipientReferences ?? []).filter((member) =>
    !term || [[member.firstName, member.lastName].filter(Boolean).join(' '), member.username]
      .some((name) => name?.toLocaleLowerCase().includes(term)));
  const candidates = [...new Map([...references, ...rows.map((row) => ({
    telegramUserId: Number(row.telegram_user_id), firstName: row.first_name ?? 'Пользователь',
    lastName: row.last_name, username: row.telegram_username,
  }))].map((member) => [member.telegramUserId, member])).values()];
  if (chat.type === 'personal') return { members: candidates.filter((member) => member.telegramUserId === Number(rows[0]?.telegram_user_id)),
    knownMembersOnly: true as const, hasMore: false, verificationFailed: false };
  const checked = await Promise.all(candidates.slice(0, 10).map((member) => checkChatMember(telegram, Number(chat.telegram_chat_id), member.telegramUserId)));
  return { members: checked.flatMap((result) => result.success ? [result.member] : []), knownMembersOnly: true as const,
    hasMore: candidates.length > 10, verificationFailed: checked.some((result) => !result.success && result.reason === 'MEMBERSHIP_UNVERIFIED') };
}
