import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import type { AgentContext } from '../../types/domain.js';
import type { TelegramMembershipGateway } from '../../telegram/TelegramAdapter.js';
import { checkChatMember, chatMemberSchema } from '../chats/chatMembers.js';
import { ensureUser } from '../users/ensureUser.js';
import { touchChatList } from '../schedule/chatList.js';

export const setReminderRecipientInputSchema = z.object({
  eventId: z.number().int().positive().safe(),
  recipientTelegramUserId: z.number().int().positive().safe().nullable(),
  expectedRecipientVersion: z.number().int().positive(),
});
export const setReminderRecipientOutputSchema = z.object({
  success: z.boolean(), changed: z.boolean(), recipient: chatMemberSchema.nullable(), recipientVersion: z.number().nullable(),
  reason: z.enum(['USER_REQUEST_REQUIRED', 'EVENT_NOT_FOUND_OR_INACTIVE', 'RECIPIENT_CHANGED', 'PRIVATE_CHAT_OWNER_ONLY',
    'NOT_A_CHAT_MEMBER', 'BOT_RECIPIENT_NOT_ALLOWED', 'MEMBERSHIP_UNVERIFIED']).nullable(),
});
type Result = z.infer<typeof setReminderRecipientOutputSchema>;
const failure = (reason: NonNullable<Result['reason']>): Result => ({ success: false, changed: false, recipient: null, recipientVersion: null, reason });

export async function setReminderRecipient(database: Kysely<Database>, telegram: TelegramMembershipGateway,
  context: AgentContext, rawInput: z.infer<typeof setReminderRecipientInputSchema>): Promise<Result> {
  const input = setReminderRecipientInputSchema.parse(rawInput);
  if (context.userId === null || context.trigger?.kind === 'notification' || context.trigger?.kind === 'list_refresh') return failure('USER_REQUEST_REQUIRED');
  const event = await database.selectFrom('events').innerJoin('chats', 'chats.id', 'events.chat_id')
    .innerJoin('users as author', 'author.id', 'events.user_id').selectAll('events')
    .select(['chats.type as chat_type', 'chats.telegram_chat_id', 'chats.user_id as owner_id', 'chats.timezone',
      'author.telegram_user_id as author_telegram_id', 'author.first_name', 'author.last_name', 'author.telegram_username'])
    .where('events.id', '=', input.eventId).where('events.chat_id', '=', context.chatId).where('events.status', '=', 'active').executeTakeFirst();
  if (!event) return failure('EVENT_NOT_FOUND_OR_INACTIVE');
  if (Number(event.recipient_version) !== input.expectedRecipientVersion) return failure('RECIPIENT_CHANGED');
  const targetId = input.recipientTelegramUserId ?? Number(event.author_telegram_id);
  let member = { telegramUserId: Number(event.author_telegram_id), firstName: event.first_name ?? 'Пользователь',
    lastName: event.last_name, username: event.telegram_username };
  if (event.chat_type === 'personal') {
    if (Number(event.owner_id) !== context.userId || targetId !== Number(event.author_telegram_id)) return failure('PRIVATE_CHAT_OWNER_ONLY');
  } else {
    const check = await checkChatMember(telegram, Number(event.telegram_chat_id), targetId);
    if (!check.success) return failure(check.reason);
    member = check.member;
  }
  const explicit = targetId !== Number(event.author_telegram_id);
  return database.transaction().execute(async (transaction) => {
    const current = await transaction.selectFrom('events').selectAll().where('id', '=', input.eventId)
      .where('chat_id', '=', context.chatId).where('status', '=', 'active').forUpdate().executeTakeFirst();
    if (!current) return failure('EVENT_NOT_FOUND_OR_INACTIVE');
    if (Number(current.recipient_version) !== input.expectedRecipientVersion) return failure('RECIPIENT_CHANGED');
    const recipient = explicit ? await ensureUser(transaction, { telegramUserId: member.telegramUserId, telegramChatId: null,
      telegramUsername: member.username, firstName: member.firstName, lastName: member.lastName, defaultTimezone: event.timezone }) : null;
    const recipientId = recipient?.id ?? null;
    const currentId = current.reminder_recipient_user_id === null ? null : Number(current.reminder_recipient_user_id);
    if (currentId === recipientId) return { success: true, changed: false, recipient: member, recipientVersion: input.expectedRecipientVersion, reason: null };
    await transaction.updateTable('events').set({ reminder_recipient_user_id: recipientId,
      recipient_version: sql`recipient_version + 1`, updated_at: new Date() }).where('id', '=', current.id).execute();
    // Invalidate in-flight text addressed to the previous recipient, retaining the same timers and buttons.
    await transaction.updateTable('notifications').set({ lock_token: null, locked_at: null, retry_at: null, last_error: null })
      .where('event_id', '=', current.id).where('status', '=', 'pending').execute();
    await touchChatList(transaction, context.chatId);
    return { success: true, changed: true, recipient: member, recipientVersion: input.expectedRecipientVersion + 1, reason: null };
  });
}
