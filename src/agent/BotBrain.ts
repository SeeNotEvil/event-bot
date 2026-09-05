import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import {
  appendMessage,
  getRecentMessages,
} from '../application/conversations/conversationHistory.js';
import { getUserPreferences } from '../application/users/userPreferences.js';
import type { Database } from '../db/types.js';
import type {
  AgentContext,
  Calendar,
  TelegramChatType,
  User,
} from '../types/domain.js';
import type { AgentRuntime, AgentRunResult } from './AgentRuntime.js';

export type Clock = () => DateTime;

export class BotBrain {
  public constructor(
    private readonly database: Kysely<Database>,
    private readonly runtime: AgentRuntime,
    private readonly historyLimit: number,
    private readonly logger: Logger,
    private readonly clock: Clock = () => DateTime.now(),
  ) {}

  public async handleMessage(
    message: string,
    user: User,
    calendar: Calendar,
    telegramChatId: number,
    telegramChatType: TelegramChatType,
  ): Promise<AgentRunResult> {
    const [history, userPreferences] = await Promise.all([
      getRecentMessages(this.database, calendar.id, this.historyLimit),
      getUserPreferences(this.database, user.id),
    ]);
    const messageForModel = calendar.type === 'group'
      ? `${user.displayName}: ${message}`
      : message;
    await appendMessage(
      this.database,
      calendar.id,
      user.id,
      { role: 'user', content: messageForModel },
      this.historyLimit,
    );

    const now = this.clock().setZone(calendar.timezone);
    if (!now.isValid) {
      throw new Error(`Invalid timezone for user ${user.id}`);
    }

    const context: AgentContext = {
      userId: user.id,
      calendarId: calendar.id,
      calendarType: calendar.type,
      calendarTitle: calendar.title,
      telegramUserId: user.telegramUserId,
      telegramChatId,
      telegramChatType,
      firstName: user.firstName,
      displayName: user.displayName,
      telegramUsername: user.telegramUsername,
      userPreferences,
      timezone: calendar.timezone,
      now: now.toISO({ suppressMilliseconds: true }) ?? now.toISO(),
    };

    const result = await this.runtime.run(messageForModel, history, context);
    await appendMessage(
      this.database,
      calendar.id,
      user.id,
      { role: 'assistant', content: result.transcript },
      this.historyLimit,
    );

    this.logger.info(
      {
        userId: user.id,
        calendarId: calendar.id,
        steps: result.steps,
        terminalTool: result.terminalTool,
      },
      'Agent run completed',
    );

    return result;
  }
}
