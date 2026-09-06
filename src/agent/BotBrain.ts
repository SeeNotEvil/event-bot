import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { appendMessage, getRecentMessages, type MessageMetadata } from '../application/conversations/conversationHistory.js';
import { getRescheduleReplyContext } from '../application/notifications/readiness.js';
import { getUserPreferences } from '../application/users/userPreferences.js';
import type { Database } from '../db/types.js';
import type { AgentContext, AgentTrigger, Calendar, TelegramChatType, User } from '../types/domain.js';
import type { AgentRuntime, AgentRunResult } from './AgentRuntime.js';

export type Clock = () => DateTime;

export class BotBrain {
  public constructor(
    private readonly database: Kysely<Database>, private readonly runtime: AgentRuntime,
    private readonly historyLimit: number, private readonly logger: Logger,
    private readonly clock: Clock = () => DateTime.now(),
  ) {}

  public async rememberMessage(message: string, user: User, calendar: Calendar, metadata: MessageMetadata): Promise<boolean> {
    return appendMessage(this.database, calendar.id, user.id, { role: 'user', content: message }, this.historyLimit,
      { ...metadata, authorName: calendar.type === 'group' ? user.displayName : undefined });
  }

  public async handleMessage(message: string, user: User, calendar: Calendar, telegramChatId: number,
    telegramChatType: TelegramChatType, metadata: MessageMetadata & { stored?: boolean; serviceReason?: string } = {},
  ): Promise<AgentRunResult> {
    const [history, preferences] = await Promise.all([
      getRecentMessages(this.database, calendar.id, this.historyLimit, metadata.messageId),
      getUserPreferences(this.database, user.id),
    ]);
    if (!metadata.stored) await this.rememberMessage(message, user, calendar, metadata);
    const now = this.clock().setZone(calendar.timezone).toISO({ suppressMilliseconds: true });
    if (!now) throw new Error('Invalid calendar timezone');
    const trigger = metadata.serviceReason ? { kind: 'service' as const, reason: metadata.serviceReason }
      : metadata.replyToMessageId === undefined ? undefined
      : await getRescheduleReplyContext(this.database, calendar.id, metadata.replyToMessageId);
    const context: AgentContext = {
      userId: user.id, calendarId: calendar.id, calendarType: calendar.type, calendarTitle: calendar.title,
      telegramUserId: user.telegramUserId, telegramChatId, telegramChatType,
      firstName: user.firstName, displayName: user.displayName, telegramUsername: user.telegramUsername,
      userPreferences: preferences, timezone: calendar.timezone, now, trigger,
    };
    return this.run(calendar.type === 'group' ? `${user.displayName}: ${message}` : message, history, context);
  }

  public async handleBackground(calendarId: number, trigger: AgentTrigger, hooks: Pick<AgentContext, 'beforeStep' | 'listClaimToken' | 'mentionRecipient'> = {}) {
    const row = await this.database.selectFrom('calendars').leftJoin('users', 'users.id', 'calendars.user_id')
      .select(['calendars.type', 'calendars.title', 'calendars.timezone', 'calendars.telegram_chat_id as group_chat',
        'users.id as owner_id', 'users.telegram_chat_id as personal_chat', 'users.first_name'])
      .where('calendars.id', '=', calendarId).executeTakeFirstOrThrow();
    const chatId = row.type === 'group' ? row.group_chat : row.personal_chat;
    if (chatId === null) throw new Error('Calendar has no Telegram destination');
    const [history, preferences] = await Promise.all([
      getRecentMessages(this.database, calendarId, this.historyLimit),
      row.type === 'personal' && row.owner_id !== null ? getUserPreferences(this.database, Number(row.owner_id)) : Promise.resolve(null),
    ]);
    const now = this.clock().setZone(row.timezone).toISO({ suppressMilliseconds: true });
    if (!now) throw new Error('Invalid calendar timezone');
    const context: AgentContext = {
      userId: null, calendarId, calendarType: row.type, calendarTitle: row.title,
      telegramUserId: null, telegramChatId: Number(chatId), telegramChatType: row.type === 'group' ? 'supergroup' : 'private',
      firstName: row.type === 'personal' ? row.first_name : null, displayName: null, telegramUsername: null,
      userPreferences: preferences, timezone: row.timezone, now, trigger, ...hooks,
    };
    const result = await this.run(JSON.stringify({ scheduled_event: trigger }), history, context);
    return { ...result, messageId: context.outgoingMessageId };
  }

  private async run(message: string, history: Awaited<ReturnType<typeof getRecentMessages>>, context: AgentContext): Promise<AgentRunResult> {
    const result = await this.runtime.run(message, history, context);
    try {
      await appendMessage(this.database, context.calendarId, context.userId,
        { role: 'assistant', content: result.transcript }, this.historyLimit,
        { messageId: context.outgoingMessageId, authorName: 'Ираида' });
    } catch (error) {
      // Delivery already succeeded; a history failure must not resend the reply.
      this.logger.error({ error, calendarId: context.calendarId }, 'Failed to save agent reply in history');
    }
    this.logger.info({ userId: context.userId, calendarId: context.calendarId, steps: result.steps, terminalTool: result.terminalTool }, 'Agent run completed');
    return result;
  }
}
