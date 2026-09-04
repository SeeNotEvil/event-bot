import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import {
  appendMessage,
  getRecentMessages,
} from '../application/conversations/conversationHistory.js';
import type { Database } from '../db/types.js';
import type { AgentContext, User } from '../types/domain.js';
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

  public async handleMessage(message: string, user: User): Promise<AgentRunResult> {
    const history = await getRecentMessages(this.database, user.id, this.historyLimit);
    await appendMessage(
      this.database,
      user.id,
      { role: 'user', content: message },
      this.historyLimit,
    );

    const now = this.clock().setZone(user.timezone);
    if (!now.isValid) {
      throw new Error(`Invalid timezone for user ${user.id}`);
    }

    const context: AgentContext = {
      userId: user.id,
      telegramUserId: user.telegramUserId,
      telegramChatId: user.telegramChatId,
      firstName: user.firstName,
      displayName: user.displayName,
      telegramUsername: user.telegramUsername,
      timezone: user.timezone,
      now: now.toISO({ suppressMilliseconds: true }) ?? now.toISO(),
    };

    const result = await this.runtime.run(message, history, context);
    await appendMessage(
      this.database,
      user.id,
      { role: 'assistant', content: result.transcript },
      this.historyLimit,
    );

    this.logger.info(
      {
        userId: user.id,
        steps: result.steps,
        terminalTool: result.terminalTool,
      },
      'Agent run completed',
    );

    return result;
  }
}
