import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { ChatMember } from 'grammy/types';
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
import { createSendMessageTool } from '../../src/agent/tools/sendMessage.tool.js';
import { createSaveUserPreferencesTool } from '../../src/agent/tools/saveUserPreferences.tool.js';
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js';
import { ToolRuntime } from '../../src/agent/tools/ToolRuntime.js';
import { defineTool } from '../../src/agent/tools/Tool.js';
import type { Database } from '../../src/db/types.js';
import type { AgentContext } from '../../src/types/domain.js';
import type { TelegramGateway } from '../../src/telegram/TelegramAdapter.js';
import { checkChatMember, requireChatMember, RecipientMembershipError } from '../../src/application/chats/chatMembers.js';
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
        reminderTimes: { anyOf: [{ type: 'array', items: { type: 'string' }, maxItems: 20 }, { type: 'null' }] },
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

  it('prevents a background run from replaying a user mutation', async () => {
    const transaction = vi.fn();
    const database = { transaction } as unknown as Kysely<Database>;
    const registry = new ToolRegistry().register(createDeleteEventTool(database));
    const runtime = new ToolRuntime(registry, silentLogger);
    await expect(runtime.execute('delete_event', { eventId: 42 }, { ...context, userId: null }))
      .resolves.toMatchObject({ ok: false, output: { error: { code: 'INVALID_CONTEXT', retryable: false } } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('delivers repeated agent-authored lists as new messages without editing an earlier reply', async () => {
    const sendText = vi.fn(async () => 42).mockResolvedValueOnce(41);
    const editText = vi.fn();
    const telegram: TelegramGateway = { sendText, editText, clearButtons: vi.fn() };
    const registry = new ToolRegistry().register(createSendMessageTool({} as Kysely<Database>, telegram));
    const runtime = new ToolRuntime(registry, silentLogger);
    const text = 'Активные задачи: сходить в Озон — 7 сентября; приготовить ужин — 8 сентября.';
    const requestContext = { ...context, chatType: 'group' as const, telegramChatId: -123 };
    await expect(runtime.execute('send_message', { text, mentionText: null }, requestContext))
      .resolves.toMatchObject({ ok: true, terminal: true, transcript: text });
    expect(requestContext.outgoingMessageId).toBe(41);
    await expect(runtime.execute('send_message', { text, mentionText: null }, requestContext))
      .resolves.toMatchObject({ ok: true, terminal: true, transcript: text });
    expect(requestContext.outgoingMessageId).toBe(42);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith(-123, text, {});
    expect(editText).not.toHaveBeenCalled();
  });

  it('blocks delivery when the recipient leaves during generation or membership cannot be verified', async () => {
    const person = { id: 456, is_bot: false, first_name: 'Анна' };
    const getChatMember = vi.fn<() => Promise<ChatMember>>().mockResolvedValue({ status: 'member', user: person });
    const sendText = vi.fn(async () => 42);
    const telegram = { getChatMember, sendText, editText: vi.fn(), clearButtons: vi.fn() };
    const runtime = new ToolRuntime(new ToolRegistry().register(createSendMessageTool({} as Kysely<Database>, telegram)), silentLogger);
    const runContext: AgentContext = { ...context, telegramChatId: -123, chatType: 'group',
      mentionRecipient: { id: person.id, firstName: person.first_name },
      beforeSend: () => requireChatMember(telegram, -123, person.id) };
    expect(await checkChatMember(telegram, -123, person.id)).toMatchObject({ success: true });

    // Telegram can report a restricted user with either membership state.
    const restricted: Extract<ChatMember, { status: 'restricted' }> = { status: 'restricted', user: person, is_member: true,
      can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
      can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
      can_send_other_messages: false, can_add_web_page_previews: false, can_change_info: false,
      can_invite_users: false, can_pin_messages: false, can_manage_topics: false,
      can_react_to_messages: false, can_edit_tag: false, until_date: 0 };
    getChatMember.mockResolvedValue(restricted);
    expect(await checkChatMember(telegram, -123, person.id)).toMatchObject({ success: true });
    const rejected: ChatMember[] = [
      { status: 'left', user: person }, { status: 'kicked', user: person, until_date: 0 },
      { ...restricted, is_member: false }, { status: 'member', user: { ...person, is_bot: true } },
    ];
    for (const member of rejected) {
      getChatMember.mockResolvedValue(member);
      await expect(runtime.execute('send_message', { text: 'Анна, задача готова?', mentionText: 'Анна' }, runContext))
        .rejects.toBeInstanceOf(RecipientMembershipError);
    }
    getChatMember.mockRejectedValue(new Error('Telegram unavailable'));
    await expect(runtime.execute('send_message', { text: 'Анна, задача готова?', mentionText: 'Анна' }, runContext))
      .rejects.toMatchObject({ reason: 'MEMBERSHIP_UNVERIFIED' });
    expect(sendText).not.toHaveBeenCalled();
  });
});
