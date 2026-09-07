import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { getRescheduleReplyContext } from '../application/notifications/readiness.js';
import type { ThreadMemory, MessageMetadata } from '../application/memory/ThreadMemory.js';
import type { MemoryContextBuilder } from '../application/memory/MemoryContextBuilder.js';
import type { Database } from '../db/types.js';
import type { AgentContext, AgentTrigger, Chat, ChatMemberReference, ConversationMessage, TelegramChatType, User } from '../types/domain.js';
import type { AgentRuntime, AgentRunResult } from './AgentRuntime.js';

export type Clock = () => DateTime;

export class BotBrain {
  public constructor(
    private readonly database: Kysely<Database>, private readonly runtime: AgentRuntime,
    private readonly threads: ThreadMemory, private readonly memoryBuilder: MemoryContextBuilder,
    private readonly logger: Logger, private readonly clock: Clock = () => DateTime.now(),
  ) {}

  public async rememberMessage(message: string, user: User, chat: Chat, metadata: MessageMetadata): Promise<boolean> {
    const thread = await this.threads.ensure(chat.id);
    return this.threads.append(thread.id, user.id, { role: 'user', content: message },
      { ...metadata, authorName: chat.type === 'group' ? user.displayName : undefined });
  }

  public async handleMessage(message: string, user: User, chat: Chat, telegramChatId: number,
    telegramChatType: TelegramChatType, metadata: MessageMetadata & { stored?: boolean; serviceReason?: string; recipientReferences?: ChatMemberReference[]; groupMessage?: AgentContext['groupMessage'] } = {},
  ): Promise<AgentRunResult> {
    // Build before appending for callers without a Telegram message ID; ordinary Telegram updates are already archived.
    const { history, memory, threadId } = await this.memoryBuilder.build(chat, message, metadata.messageId);
    if (!metadata.stored) await this.rememberMessage(message, user, chat, metadata);
    let sourceQuery = this.database.selectFrom('conversation_messages').select('id')
      .where('thread_id', '=', threadId).where('user_id', '=', user.id).where('role', '=', 'user');
    if (metadata.messageId !== undefined) sourceQuery = sourceQuery.where('telegram_message_id', '=', metadata.messageId);
    const source = await sourceQuery.orderBy('id', 'desc').executeTakeFirstOrThrow();
    const now = this.clock().setZone(chat.timezone).toISO({ suppressMilliseconds: true });
    if (!now) throw new Error('Invalid chat timezone');
    const trigger = metadata.serviceReason ? { kind: 'service' as const, reason: metadata.serviceReason }
      : metadata.replyToMessageId === undefined ? undefined
      : await getRescheduleReplyContext(this.database, chat.id, metadata.replyToMessageId);
    const context: AgentContext = {
      userId: user.id, chatId: chat.id, threadId, memory, sourceMessageId: Number(source.id), chatType: chat.type, chatTitle: chat.title,
      telegramUserId: user.telegramUserId, telegramChatId, telegramChatType,
      firstName: user.firstName, displayName: user.displayName, telegramUsername: user.telegramUsername,
      userPreferences: chat.type === 'personal' ? memory.profile?.content ?? null : null, timezone: chat.timezone, now, trigger,
      recipientReferences: metadata.recipientReferences ?? [],
      groupMessage: metadata.groupMessage,
    };
    return this.run(chat.type === 'group' ? `${user.displayName}: ${message}` : message, history, context);
  }

  public async handleBackground(chatId: number, trigger: AgentTrigger, hooks: Pick<AgentContext, 'beforeStep' | 'beforeSend' | 'mentionRecipient'> = {}) {
    const row = await this.database.selectFrom('chats').leftJoin('users', 'users.id', 'chats.user_id')
      .select(['chats.type', 'chats.title', 'chats.timezone', 'chats.telegram_chat_id as group_chat',
        'users.id as owner_id', 'users.telegram_chat_id as personal_chat', 'users.first_name'])
      .where('chats.id', '=', chatId).executeTakeFirstOrThrow();
    const destination = row.type === 'group' ? row.group_chat : row.personal_chat;
    if (destination === null) throw new Error('Chat has no Telegram destination');
    const job = trigger.kind === 'agent_task' || trigger.kind === 'notification'
      ? await this.database.selectFrom('notifications').innerJoin('users as actor', 'actor.id', 'notifications.created_by_user_id')
        .select(['actor.id', 'actor.telegram_user_id', 'actor.first_name', 'actor.last_name', 'actor.telegram_username'])
        .where('notifications.id', '=', trigger.notificationId).where('notifications.chat_id', '=', chatId).executeTakeFirstOrThrow()
      : null;
    if (row.type === 'personal' && job && Number(job.id) !== Number(row.owner_id)) throw new Error('Task owner does not own this personal chat');
    const { history, memory, threadId } = await this.memoryBuilder.build({ id: chatId, type: row.type,
      userId: row.owner_id === null ? null : Number(row.owner_id) }, JSON.stringify(trigger));
    const timezone = trigger.kind === 'agent_task' ? trigger.timezone : row.timezone;
    const now = this.clock().setZone(timezone).toISO({ suppressMilliseconds: true });
    if (!now) throw new Error('Invalid chat timezone');
    const context: AgentContext = {
      userId: job ? Number(job.id) : null, chatId, threadId, memory, chatType: row.type, chatTitle: row.title,
      telegramUserId: job ? Number(job.telegram_user_id) : null, telegramChatId: Number(destination), telegramChatType: row.type === 'group' ? 'supergroup' : 'private',
      firstName: job?.first_name ?? (row.type === 'personal' ? row.first_name : null),
      displayName: job ? [job.first_name, job.last_name].filter(Boolean).join(' ') : null, telegramUsername: job?.telegram_username ?? null,
      userPreferences: row.type === 'personal' ? memory.profile?.content ?? null : null, timezone, now, trigger, ...hooks,
    };
    const result = await this.run(JSON.stringify({ scheduled_event: trigger }), history, context);
    return { ...result, messageId: context.outgoingMessageId };
  }

  private async run(message: string, history: ConversationMessage[], context: AgentContext): Promise<AgentRunResult> {
    const result = await this.runtime.run(message, history, context);
    if (result.terminalTool === 'send_message') {
      try {
        await this.threads.append(context.threadId, context.userId,
          { role: 'assistant', content: result.transcript },
          { messageId: context.outgoingMessageId, authorName: 'Мэй Мэй' });
      } catch (error) {
        // Delivery already succeeded; a history failure must not resend the reply.
        this.logger.error({ error, chatId: context.chatId }, 'Failed to save agent reply in history');
      }
    }
    this.logger.info({ userId: context.userId, chatId: context.chatId, steps: result.steps, terminalTool: result.terminalTool }, 'Agent run completed');
    return result;
  }
}
