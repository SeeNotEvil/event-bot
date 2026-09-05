import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createCreateEventsTool } from '../../src/agent/tools/createEvents.tool.js';
import { createCreateNotificationTool } from '../../src/agent/tools/createNotification.tool.js';
import { createCompleteEventTool } from '../../src/agent/tools/completeEvent.tool.js';
import { createDeleteEventTool } from '../../src/agent/tools/deleteEvent.tool.js';
import { createDeleteEventsTool } from '../../src/agent/tools/deleteEvents.tool.js';
import { createDeleteNotificationTool } from '../../src/agent/tools/deleteNotification.tool.js';
import { createSearchEventsTool } from '../../src/agent/tools/searchEvents.tool.js';
import { createSearchNotificationsTool } from '../../src/agent/tools/searchNotifications.tool.js';
import { createRescheduleEventTool } from '../../src/agent/tools/rescheduleEvent.tool.js';
import { createSearchScheduleTool } from '../../src/agent/tools/searchSchedule.tool.js';
import { createSendEventListTool } from '../../src/agent/tools/sendEventList.tool.js';
import { createSaveUserPreferencesTool } from '../../src/agent/tools/saveUserPreferences.tool.js';
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js';
import { ToolRuntime } from '../../src/agent/tools/ToolRuntime.js';
import { defineTool } from '../../src/agent/tools/Tool.js';
import type { Database } from '../../src/db/types.js';
import type { AgentContext } from '../../src/types/domain.js';
import type { TelegramGateway } from '../../src/telegram/TelegramAdapter.js';
import { silentLogger } from '../helpers.js';

const context: AgentContext = {
  userId: 14,
  telegramUserId: 123,
  telegramChatId: 123,
  firstName: 'Иван',
  displayName: 'Иван Петров',
  telegramUsername: 'ivan_petrov',
  userPreferences: null,
  timezone: 'Europe/Moscow',
  now: '2026-09-04T21:30:00+03:00',
};

describe('ToolRegistry and ToolRuntime', () => {
  it('publishes strict JSON schema with required nullable fields', () => {
    const registry = new ToolRegistry().register(
      defineTool({
        name: 'sample',
        description: 'Sample tool',
        input: z.object({ value: z.string().nullable() }),
        output: z.object({ accepted: z.boolean() }),
        execute: async () => ({ accepted: true }),
      }),
    );

    const [spec] = registry.specs();
    expect(spec).toMatchObject({ name: 'sample', strict: true });
    expect(spec?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['value'],
    });
  });

  it('validates input and output around whitelisted execution', async () => {
    const execute = vi.fn(async (_context: AgentContext, input: { value: string | null }) => ({
      accepted: input.value !== null,
    }));
    const registry = new ToolRegistry().register(
      defineTool({
        name: 'sample',
        description: 'Sample tool',
        input: z.object({ value: z.string().nullable() }),
        output: z.object({ accepted: z.boolean() }),
        execute,
      }),
    );
    const runtime = new ToolRuntime(registry, silentLogger);

    const success = await runtime.execute('sample', { value: 'yes' }, context);
    expect(success).toMatchObject({ ok: true, output: { accepted: true } });
    expect(execute).toHaveBeenCalledOnce();

    const invalid = await runtime.execute('sample', {}, context);
    expect(invalid).toMatchObject({
      ok: false,
      output: { error: { code: 'INVALID_ARGUMENTS', retryable: true } },
    });

    const unknown = await runtime.execute('missing', {}, context);
    expect(unknown).toMatchObject({
      ok: false,
      output: { error: { code: 'UNKNOWN_TOOL', retryable: false } },
    });
  });

  it('generates strict schemas for every domain tool', () => {
    const database = {} as Kysely<Database>;
    const specs = new ToolRegistry()
      .register(createCreateEventsTool(database))
      .register(createSearchEventsTool(database))
      .register(createSearchScheduleTool(database))
      .register(createCompleteEventTool(database))
      .register(createRescheduleEventTool(database))
      .register(createDeleteEventTool(database))
      .register(createDeleteEventsTool(database))
      .register(createCreateNotificationTool(database))
      .register(createSearchNotificationsTool(database))
      .register(createDeleteNotificationTool(database))
      .register(createSaveUserPreferencesTool(database))
      .specs();

    expect(specs.map((spec) => spec.name)).toEqual([
      'create_events',
      'search_events',
      'search_schedule',
      'complete_event',
      'reschedule_event',
      'delete_event',
      'delete_events',
      'create_notification',
      'search_notifications',
      'delete_notification',
      'save_user_preferences',
    ]);
    expect(specs[0]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['events'],
      properties: {
        events: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            additionalProperties: false,
            required: ['title', 'description', 'dateFrom', 'dateTo', 'time'],
          },
        },
      },
    });
    expect(specs[1]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['query', 'statuses', 'dateFrom', 'dateTo', 'limit'],
    });
    expect(specs[2]?.parameters).toMatchObject({
      additionalProperties: false,
      required: [
        'query',
        'eventStatuses',
        'eventDateFrom',
        'eventDateTo',
        'reminderStatuses',
        'reminderFrom',
        'reminderTo',
        'requireReminder',
        'limit',
      ],
    });
    expect(specs[3]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['eventId'],
    });
    expect(specs[4]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['eventId', 'dateFrom', 'dateTo', 'time', 'reminderTimes'],
      properties: {
        reminderTimes: {
          type: 'array',
          maxItems: 20,
        },
      },
    });
    expect(specs[6]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['eventIds'],
      properties: {
        eventIds: {
          type: 'array',
          minItems: 2,
          maxItems: 100,
        },
      },
    });
    expect(specs[7]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['eventId', 'remindAt'],
    });
    expect(specs[8]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['eventId', 'statuses', 'remindFrom', 'remindTo', 'limit'],
    });
    expect(specs[9]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['notificationId'],
    });
    expect(specs[10]?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['preferences'],
    });
    expect(JSON.stringify(specs[10]?.parameters)).toContain('"maxLength":4000');
  });

  it('passes the trusted Telegram first name to the event-list adapter', async () => {
    const sendEventList = vi.fn(async () => 'События\n\n12 сентября\nИван — Стоматолог');
    const telegram: TelegramGateway = {
      sendMessage: vi.fn(async (_chatId: number, text: string) => text),
      sendEventReminder: vi.fn(async () => 'Напоминание'),
      sendEventList,
    };
    const tool = createSendEventListTool(telegram);
    const registry = new ToolRegistry().register(tool);
    const runtime = new ToolRuntime(registry, silentLogger);
    const events = [
      {
        id: 17,
        title: 'Стоматолог',
        description: null,
        dateFrom: '2026-09-12',
        dateTo: null,
        time: null,
        status: 'active' as const,
        completedAt: null,
        notifications: [],
      },
    ];

    await expect(
      runtime.execute('send_event_list', { title: 'События', events }, context),
    ).resolves.toMatchObject({ ok: true, terminal: true });
    expect(sendEventList).toHaveBeenCalledWith(
      context.telegramChatId,
      'События',
      events,
      context.now,
      'Иван',
    );
  });
});
