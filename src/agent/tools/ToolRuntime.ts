import type { Logger } from 'pino';
import type { AgentContext } from '../../types/domain.js';
import { UnknownToolError } from './ToolRegistry.js';
import type { ToolRegistry } from './ToolRegistry.js';
import { StaleAgentTask } from '../../application/StaleAgentTask.js';
import { ChatMentionError, RecipientMembershipError } from '../../application/chats/chatMembers.js';
import { AccessDeniedError, isLiveRequest, type AccessPolicy } from '../../application/access/BotAccess.js';

export type ToolRuntimeSuccess = {
  ok: true;
  output: unknown;
  terminal: boolean;
  transcript: string | null;
};

export type ToolRuntimeFailure = {
  ok: false;
  output: {
    error: {
      code: 'ACCESS_DENIED' | 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'INVALID_CONTEXT' | 'INVALID_OUTPUT' | 'EXECUTION_FAILED';
      message: string;
      retryable: boolean;
    };
  };
  terminal: false;
  transcript: null;
};

export type ToolRuntimeResult = ToolRuntimeSuccess | ToolRuntimeFailure;

export class ToolRuntime {
  public constructor(
    private readonly registry: ToolRegistry,
    private readonly logger: Logger,
    private readonly access: AccessPolicy,
  ) {}

  public async execute(
    name: string,
    rawArguments: unknown,
    context: AgentContext,
  ): Promise<ToolRuntimeResult> {
    let tool;

    try {
      if (!await this.access.isAllowed(context.telegramUserId)) {
        return this.failure('ACCESS_DENIED', 'Access denied.', false);
      }
    } catch (error) {
      this.logger.error({ error, toolName: name }, 'Could not verify tool access');
      return this.failure('ACCESS_DENIED', 'Access denied.', false);
    }

    try {
      tool = this.registry.get(name);
    } catch (error) {
      if (error instanceof UnknownToolError) {
        return this.failure('UNKNOWN_TOOL', 'Инструмент недоступен.', false);
      }
      throw error;
    }

    if (tool.access === 'owner' && (!this.access.isOwner(context.telegramUserId) || !isLiveRequest(context))) {
      return this.failure('ACCESS_DENIED', 'Access denied.', false);
    }
    if (tool.requiresUser && context.userId === null) {
      return this.failure('INVALID_CONTEXT', 'Сервер не определил владельца этого действия.', false);
    }
    if (tool.availableWhen && !tool.availableWhen(context)) {
      return this.failure('INVALID_CONTEXT', 'Инструмент недоступен в текущем контексте.', false);
    }

    const input = tool.input.safeParse(rawArguments);
    if (!input.success) {
      return this.failure(
        'INVALID_ARGUMENTS',
        input.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        true,
      );
    }

    let rawOutput: unknown;
    try {
      await context.beforeStep?.();
      rawOutput = await tool.execute(context, input.data);
    } catch (error) {
      if (error instanceof AccessDeniedError) return this.failure('ACCESS_DENIED', 'Access denied.', false);
      if (error instanceof StaleAgentTask || error instanceof RecipientMembershipError) throw error;
      if (error instanceof ChatMentionError) return this.failure('EXECUTION_FAILED', error.message, true);
      this.logger.error(
        {
          error,
          toolName: name,
          userId: context.userId,
        },
        'Tool execution failed',
      );
      return this.failure('EXECUTION_FAILED', 'Не удалось выполнить действие.', true);
    }

    const output = tool.output.safeParse(rawOutput);
    if (!output.success) {
      this.logger.error(
        {
          issues: output.error.issues,
          toolName: name,
          userId: context.userId,
        },
        'Tool returned an invalid result',
      );
      return this.failure('INVALID_OUTPUT', 'Инструмент вернул некорректный результат.', false);
    }

    return {
      ok: true,
      output: output.data,
      terminal: tool.terminal ?? false,
      transcript: tool.transcript?.(input.data, output.data) ?? null,
    };
  }

  private failure(
    code: ToolRuntimeFailure['output']['error']['code'],
    message: string,
    retryable: boolean,
  ): ToolRuntimeFailure {
    return {
      ok: false,
      output: { error: { code, message, retryable } },
      terminal: false,
      transcript: null,
    };
  }
}
