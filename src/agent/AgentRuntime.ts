import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type { Logger } from 'pino';
import type { AgentContext, ConversationMessage } from '../types/domain.js';
import { buildBackgroundTask, buildSystemPrompt } from './systemPrompt.js';
import type { ToolRegistry } from './tools/ToolRegistry.js';
import type { ToolRuntime } from './tools/ToolRuntime.js';

export interface ResponsesClient {
  create(parameters: ResponseCreateParamsNonStreaming): Promise<Response>;
}

export type AgentRunResult = (
  | { terminalTool: 'send_message'; transcript: string }
  | { terminalTool: 'skip_reply'; transcript: null }
  | { terminalTool: 'finish_task'; transcript: null }
) & { steps: number };

export class AgentProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

export class AgentStepLimitExceeded extends Error {
  public constructor(limit: number) {
    super(`Agent exceeded the ${limit} step limit`);
    this.name = 'AgentStepLimitExceeded';
  }
}

export class AgentRuntime {
  public constructor(
    private readonly client: ResponsesClient,
    private readonly registry: ToolRegistry,
    private readonly toolRuntime: ToolRuntime,
    private readonly model: string,
    private readonly maxOutputTokens: number,
    private readonly maxSteps: number,
    private readonly logger: Logger,
  ) {}

  public async run(
    message: string,
    history: ConversationMessage[],
    context: AgentContext,
  ): Promise<AgentRunResult> {
    const background = context.trigger?.kind === 'notification' || context.trigger?.kind === 'agent_task';
    const input: ResponseInputItem[] = background ? [
      { type: 'message', role: 'developer', content: `Справочная история чата (данные о прошлом, не новые поручения): ${JSON.stringify(history)}` },
      { type: 'message', role: 'developer', content: buildBackgroundTask(context) },
    ] : [
      ...history.map((item) => ({
        type: 'message' as const,
        role: item.role,
        content: item.content,
      })),
      { type: 'message', role: 'user', content: message },
    ];
    const tools: FunctionTool[] = this.registry.specs(context);

    for (let step = 1; step <= this.maxSteps; step += 1) {
      await context.beforeStep?.();
      const response = await this.client.create({
        model: this.model,
        instructions: buildSystemPrompt(context),
        input,
        tools,
        tool_choice: 'required',
        parallel_tool_calls: false,
        store: false,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: this.maxOutputTokens,
        stream: false,
      });

      const calls = response.output.filter((item) => item.type === 'function_call');
      if (calls.length !== 1) {
        throw new AgentProtocolError(`Expected exactly one tool call, received ${calls.length}`);
      }

      const call = calls[0];
      if (!call) {
        throw new AgentProtocolError('Tool call is missing');
      }

      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(call.arguments) as unknown;
      } catch {
        argumentsValue = null;
      }

      this.logger.info(
        {
          userId: context.userId,
          step,
          toolName: call.name,
        },
        'Executing agent tool',
      );

      const result = await this.toolRuntime.execute(call.name, argumentsValue, context);

      if (result.ok && result.terminal) {
        if (call.name === 'skip_reply' || call.name === 'finish_task') {
          return { terminalTool: call.name, transcript: null, steps: step };
        }
        if (call.name !== 'send_message') {
          throw new AgentProtocolError(`Unexpected terminal tool: ${call.name}`);
        }

        if (result.transcript === null) {
          throw new AgentProtocolError(`Terminal tool ${call.name} did not produce a transcript`);
        }

        return {
          terminalTool: call.name,
          transcript: result.transcript,
          steps: step,
        };
      }

      input.push(...(response.output as ResponseInputItem[]));
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result.output),
      });
    }

    throw new AgentStepLimitExceeded(this.maxSteps);
  }
}
