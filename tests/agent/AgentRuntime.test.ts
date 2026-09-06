import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentRuntime,
  AgentStepLimitExceeded,
  type ResponsesClient,
} from '../../src/agent/AgentRuntime.js';
import { defineTool } from '../../src/agent/tools/Tool.js';
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js';
import { ToolRuntime } from '../../src/agent/tools/ToolRuntime.js';
import type { AgentContext } from '../../src/types/domain.js';
import { silentLogger } from '../helpers.js';

const context: AgentContext = {
  userId: 14,
  chatId: 7,
  threadId: 11,
  chatType: 'personal',
  chatTitle: null,
  telegramUserId: 123,
  telegramChatId: 123,
  telegramChatType: 'private',
  firstName: 'Иван',
  displayName: 'Иван Петров',
  telegramUsername: 'ivan_petrov',
  userPreferences: null,
  timezone: 'Europe/Moscow',
  now: '2026-09-04T21:30:00+03:00',
};

function toolCall(name: string, callId: string, args: unknown): ResponseFunctionToolCall {
  return {
    type: 'function_call',
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
  };
}

function response(...output: ResponseFunctionToolCall[]): Response {
  return { output } as unknown as Response;
}

class ScriptedClient implements ResponsesClient {
  public readonly requests: ResponseCreateParamsNonStreaming[] = [];

  public constructor(private readonly responses: Response[]) {}

  public async create(parameters: ResponseCreateParamsNonStreaming): Promise<Response> {
    this.requests.push(structuredClone(parameters));
    const next = this.responses.shift();
    if (!next) {
      throw new Error('Script exhausted');
    }
    return next;
  }
}

describe('AgentRuntime', () => {
  it('feeds tool results back and stops only at an interaction tool', async () => {
    const search = vi.fn(async () => ({ events: [] as unknown[] }));
    const send = vi.fn(async (_context: AgentContext, input: { text: string }) => ({
      success: true as const,
      transcript: input.text,
    }));
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'search_events',
          description: 'Search',
          input: z.object({ query: z.string().nullable() }),
          output: z.object({ events: z.array(z.unknown()) }),
          execute: search,
        }),
      )
      .register(
        defineTool({
          name: 'send_message',
          description: 'Send',
          input: z.object({ text: z.string() }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: send,
          transcript: (_input, output) => output.transcript,
        }),
      );
    const client = new ScriptedClient([
      response(toolCall('search_events', 'call-search', { query: null })),
      response(toolCall('send_message', 'call-send', { text: 'Событий нет.' })),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      10,
      silentLogger,
    );

    const result = await runtime.run('что у меня есть?', [], context);

    expect(result).toEqual({
      terminalTool: 'send_message',
      transcript: 'Событий нет.',
      steps: 2,
    });
    expect(search).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(client.requests[0]).toMatchObject({
      tool_choice: 'required',
      parallel_tool_calls: false,
      store: false,
      max_output_tokens: 16_384,
    });
    expect(client.requests[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-search',
          output: '{"events":[]}',
        }),
      ]),
    );
  });

  it('passes a schedule search result to the event-list interaction tool', async () => {
    const events = [
      {
        id: 17,
        title: 'Стоматолог',
        notifications: [{ id: 31, remindAt: '2026-09-05T12:00', status: 'pending' }],
      },
    ];
    const search = vi.fn(async () => ({ events }));
    const send = vi.fn(
      async (_context: AgentContext, input: { title: string; events: unknown[] }) => ({
        success: true as const,
        transcript: input.title,
      }),
    );
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'search_schedule',
          description: 'Search schedule',
          input: z.object({ eventDateFrom: z.string().nullable() }),
          output: z.object({ events: z.array(z.unknown()) }),
          execute: search,
        }),
      )
      .register(
        defineTool({
          name: 'send_event_list',
          description: 'Send event list',
          input: z.object({ title: z.string(), events: z.array(z.unknown()) }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: send,
          transcript: (_input, output) => output.transcript,
        }),
      );
    const client = new ScriptedClient([
      response(
        toolCall('search_schedule', 'schedule-search', {
          eventDateFrom: '2026-09-04',
        }),
      ),
      response(
        toolCall('send_event_list', 'schedule-send', {
          title: 'События на сегодня',
          events,
        }),
      ),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      3,
      silentLogger,
    );

    await expect(runtime.run('покажи события на сегодня', [], context)).resolves.toMatchObject({
      terminalTool: 'send_event_list',
      steps: 2,
    });
    expect(search).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(context, {
      title: 'События на сегодня',
      events,
    });
  });

  it('returns validation failures to the model so it can recover', async () => {
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'action',
          description: 'Action',
          input: z.object({ requiredValue: z.string() }),
          output: z.object({ success: z.boolean() }),
          execute: async () => ({ success: true }),
        }),
      )
      .register(
        defineTool({
          name: 'send_message',
          description: 'Send',
          input: z.object({ text: z.string() }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: async (_context, input) => ({ success: true, transcript: input.text }),
          transcript: (_input, output) => output.transcript,
        }),
      );
    const client = new ScriptedClient([
      response(toolCall('action', 'bad-call', {})),
      response(toolCall('send_message', 'send-call', { text: 'Уточните значение.' })),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      3,
      silentLogger,
    );

    await expect(runtime.run('сделай', [], context)).resolves.toMatchObject({ steps: 2 });
    const secondInput = client.requests[1]?.input;
    expect(JSON.stringify(secondInput)).toContain('INVALID_ARGUMENTS');
  });

  it('feeds a fresh event search into one idempotent completion and confirmation', async () => {
    const event = {
      id: 17,
      title: 'Стоматолог',
      status: 'active',
      completedAt: null,
    };
    const search = vi.fn(async () => ({ events: [event] }));
    const complete = vi.fn(async () => ({
      success: true as const,
      changed: true,
      event: {
        ...event,
        status: 'completed' as const,
        completedAt: '2026-09-04T18:31:00.000Z',
      },
      cancelledNotificationCount: 1,
    }));
    const send = vi.fn(async (_context: AgentContext, input: { text: string }) => ({
      success: true as const,
      transcript: input.text,
    }));
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'search_events',
          description: 'Search events',
          input: z.object({ query: z.string(), statuses: z.array(z.string()) }),
          output: z.object({ events: z.array(z.unknown()) }),
          execute: search,
        }),
      )
      .register(
        defineTool({
          name: 'complete_event',
          description: 'Complete event',
          input: z.object({ eventId: z.number() }),
          output: z.object({
            success: z.literal(true),
            changed: z.boolean(),
            event: z.unknown(),
            cancelledNotificationCount: z.number(),
          }),
          execute: complete,
        }),
      )
      .register(
        defineTool({
          name: 'send_message',
          description: 'Send',
          input: z.object({ text: z.string() }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: send,
          transcript: (_input, output) => output.transcript,
        }),
      );
    const client = new ScriptedClient([
      response(
        toolCall('search_events', 'search-completable', {
          query: 'стоматолог',
          statuses: ['active', 'completed'],
        }),
      ),
      response(toolCall('complete_event', 'complete', { eventId: 17 })),
      response(
        toolCall('send_message', 'confirm-completion', {
          text: 'Отметил «Стоматолог» выполненным.',
        }),
      ),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      4,
      silentLogger,
    );

    await expect(runtime.run('стоматолога сделал', [], context)).resolves.toEqual({
      terminalTool: 'send_message',
      transcript: 'Отметил «Стоматолог» выполненным.',
      steps: 3,
    });
    expect(search).toHaveBeenCalledWith(context, {
      query: 'стоматолог',
      statuses: ['active', 'completed'],
    });
    expect(complete).toHaveBeenCalledWith(context, { eventId: 17 });
  });

  it('passes a clarification exchange into the turn that creates the complete batch', async () => {
    const create = vi.fn(
      async (
        _context: AgentContext,
        input: {
          events: Array<{
            title: string;
            description: string | null;
            dateFrom: string;
            dateTo: string | null;
            time: string | null;
          }>;
        },
      ) => ({
        createdCount: input.events.length,
        dateRange: { from: '2026-09-05', to: '2026-09-05' },
        events: input.events.map((event, index) => ({
          id: 17 + index,
          ...event,
          status: 'active' as const,
          completedAt: null,
        })),
      }),
    );
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'create_events',
          description: 'Create the complete event batch only after every date is known',
          input: z.object({
            events: z.array(
              z.object({
                title: z.string(),
                description: z.string().nullable(),
                dateFrom: z.string(),
                dateTo: z.string().nullable(),
                time: z.string().nullable(),
              }),
            ),
          }),
          output: z.object({
            createdCount: z.number(),
            dateRange: z.object({ from: z.string(), to: z.string() }),
            events: z.array(z.unknown()),
          }),
          execute: create,
        }),
      )
      .register(
        defineTool({
          name: 'send_message',
          description: 'Send',
          input: z.object({ text: z.string() }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: async (_context, input) => ({ success: true, transcript: input.text }),
          transcript: (_input, output) => output.transcript,
        }),
      );
    const eventInput = {
      title: 'Стоматолог',
      description: null,
      dateFrom: '2026-09-05',
      dateTo: null,
      time: '13:00',
    };
    const client = new ScriptedClient([
      response(toolCall('create_events', 'create-call', { events: [eventInput] })),
      response(
        toolCall('send_message', 'send-call', {
          text: 'Добавил «Стоматолог» на 5 сентября в 13:00.',
        }),
      ),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      3,
      silentLogger,
    );
    const history = [
      { role: 'user' as const, content: 'добавь стоматолога' },
      {
        role: 'assistant' as const,
        content: 'На какую дату добавить «Стоматолог»?',
      },
    ];

    await runtime.run('завтра в 13 00', history, context);

    expect(client.requests[0]?.input).toEqual([
      { type: 'message', role: 'user', content: 'добавь стоматолога' },
      {
        type: 'message',
        role: 'assistant',
        content: 'На какую дату добавить «Стоматолог»?',
      },
      { type: 'message', role: 'user', content: 'завтра в 13 00' },
    ]);
    expect(create).toHaveBeenCalledWith(context, { events: [eventInput] });
  });

  it('rechecks state and reschedules after the user answers about reminders', async () => {
    const searchEvents = vi.fn(async () => ({
      events: [
        {
          id: 17,
          title: 'Стоматолог',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: '18:00',
        },
      ],
    }));
    const searchNotifications = vi.fn(async () => ({
      notifications: [
        {
          id: 31,
          eventId: 17,
          remindAt: '2026-09-12T17:00',
          status: 'pending',
        },
      ],
    }));
    const reschedule = vi.fn(async () => ({ success: true as const, changed: true }));
    const send = vi.fn(async (_context: AgentContext, input: { text: string }) => ({
      success: true as const,
      transcript: input.text,
    }));
    const registry = new ToolRegistry()
      .register(
        defineTool({
          name: 'search_events',
          description: 'Search events',
          input: z.object({ query: z.string() }),
          output: z.object({ events: z.array(z.unknown()) }),
          execute: searchEvents,
        }),
      )
      .register(
        defineTool({
          name: 'search_notifications',
          description: 'Search notifications',
          input: z.object({ eventId: z.number() }),
          output: z.object({ notifications: z.array(z.unknown()) }),
          execute: searchNotifications,
        }),
      )
      .register(
        defineTool({
          name: 'reschedule_event',
          description: 'Reschedule event',
          input: z.object({
            eventId: z.number(),
            dateFrom: z.string(),
            dateTo: z.string().nullable(),
            time: z.string().nullable(),
            reminderTimes: z.array(z.string()),
          }),
          output: z.object({ success: z.literal(true), changed: z.boolean() }),
          execute: reschedule,
        }),
      )
      .register(
        defineTool({
          name: 'send_message',
          description: 'Send',
          input: z.object({ text: z.string() }),
          output: z.object({ success: z.literal(true), transcript: z.string() }),
          terminal: true,
          execute: send,
          transcript: (_input, output) => output.transcript,
        }),
      );
    const rescheduleInput = {
      eventId: 17,
      dateFrom: '2026-09-05',
      dateTo: null,
      time: '13:00',
      reminderTimes: ['2026-09-05T12:00'],
    };
    const client = new ScriptedClient([
      response(toolCall('search_events', 'search-event', { query: 'стоматолог' })),
      response(toolCall('search_notifications', 'search-reminders', { eventId: 17 })),
      response(toolCall('reschedule_event', 'reschedule', rescheduleInput)),
      response(
        toolCall('send_message', 'send-confirmation', {
          text: 'Перенёс «Стоматолог» на завтра в 13:00 и напомню в 12:00.',
        }),
      ),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      5,
      silentLogger,
    );
    const history = [
      { role: 'user' as const, content: 'перенеси стоматолога на завтра в 13 00' },
      {
        role: 'assistant' as const,
        content: 'Сейчас есть напоминание. Когда напомнить теперь?',
      },
    ];

    await expect(runtime.run('за час', history, context)).resolves.toMatchObject({
      terminalTool: 'send_message',
      steps: 4,
    });

    expect(client.requests[0]?.input).toEqual([
      { type: 'message', role: 'user', content: history[0]?.content },
      { type: 'message', role: 'assistant', content: history[1]?.content },
      { type: 'message', role: 'user', content: 'за час' },
    ]);
    expect(searchEvents).toHaveBeenCalledOnce();
    expect(searchNotifications).toHaveBeenCalledOnce();
    expect(reschedule).toHaveBeenCalledWith(context, rescheduleInput);
  });

  it('enforces the configured step limit', async () => {
    const registry = new ToolRegistry().register(
      defineTool({
        name: 'loop',
        description: 'Loop',
        input: z.object({}),
        output: z.object({ ok: z.literal(true) }),
        execute: async () => ({ ok: true as const }),
      }),
    );
    const client = new ScriptedClient([
      response(toolCall('loop', 'one', {})),
      response(toolCall('loop', 'two', {})),
    ]);
    const runtime = new AgentRuntime(
      client,
      registry,
      new ToolRuntime(registry, silentLogger),
      'gpt-5.4-mini',
      16_384,
      2,
      silentLogger,
    );

    await expect(runtime.run('зациклись', [], context)).rejects.toBeInstanceOf(
      AgentStepLimitExceeded,
    );
  });
});
