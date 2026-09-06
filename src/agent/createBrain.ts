import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../db/types.js';
import type { TelegramGateway, TelegramMembershipGateway } from '../telegram/TelegramAdapter.js';
import { AgentRuntime, type ResponsesClient } from './AgentRuntime.js';
import { BotBrain, type Clock } from './BotBrain.js';
import { MysqlThreadMemory } from '../application/memory/MysqlThreadMemory.js';
import { MysqlMemoryStore } from '../application/memory/MysqlMemoryStore.js';
import { MemoryContextBuilder } from '../application/memory/MemoryContextBuilder.js';
import { createSearchMemoryTool, createSaveMemoryTool, createForgetMemoryTool } from './tools/memory.tools.js';
import { ToolRegistry } from './tools/ToolRegistry.js';
import { ToolRuntime } from './tools/ToolRuntime.js';
import { createCreateEventsTool } from './tools/createEvents.tool.js';
import { createSearchEventsTool } from './tools/searchEvents.tool.js';
import { createSearchScheduleTool } from './tools/searchSchedule.tool.js';
import { createCompleteEventTool } from './tools/completeEvent.tool.js';
import { createRescheduleEventTool } from './tools/rescheduleEvent.tool.js';
import { createDeleteEventTool } from './tools/deleteEvent.tool.js';
import { createDeleteEventsTool } from './tools/deleteEvents.tool.js';
import { createCreateNotificationTool } from './tools/createNotification.tool.js';
import { createSearchNotificationsTool } from './tools/searchNotifications.tool.js';
import { createDeleteNotificationTool } from './tools/deleteNotification.tool.js';
import { createSaveUserPreferencesTool } from './tools/saveUserPreferences.tool.js';
import { createSendMessageTool } from './tools/sendMessage.tool.js';
import { createSendEventListTool } from './tools/sendEventList.tool.js';
import { createSearchChatMembersTool, createSetReminderRecipientTool } from './tools/reminderRecipient.tools.js';
import { createReadEventTool, createReadTaskListTool, createReadChatMessagesTool,
  createConfigureNotificationsTool, createRecordReadinessTool } from './tools/workflow.tools.js';

export function createBrain(database: Kysely<Database>, telegram: TelegramGateway & TelegramMembershipGateway, client: ResponsesClient, config: AppConfig, logger: Logger, clock?: Clock) {
  const threads = new MysqlThreadMemory(database);
  const memories = new MysqlMemoryStore(database);
  const memoryBuilder = new MemoryContextBuilder(threads, memories, config.conversationHistoryLimit);
  const registry = new ToolRegistry()
    .register(createCreateEventsTool(database)).register(createSearchEventsTool(database))
    .register(createSearchScheduleTool(database)).register(createReadEventTool(database))
    .register(createSearchChatMembersTool(database, telegram)).register(createSetReminderRecipientTool(database, telegram))
    .register(createReadTaskListTool(database)).register(createReadChatMessagesTool(threads))
    .register(createSearchMemoryTool(memories)).register(createSaveMemoryTool(memories)).register(createForgetMemoryTool(memories))
    .register(createCompleteEventTool(database)).register(createRescheduleEventTool(database))
    .register(createDeleteEventTool(database)).register(createDeleteEventsTool(database))
    .register(createCreateNotificationTool(database)).register(createSearchNotificationsTool(database))
    .register(createDeleteNotificationTool(database)).register(createConfigureNotificationsTool(database))
    .register(createRecordReadinessTool(database)).register(createSaveUserPreferencesTool(database))
    .register(createSendMessageTool(database, telegram)).register(createSendEventListTool(database, telegram));
  const runtime = new AgentRuntime(client, registry, new ToolRuntime(registry, logger),
    config.openai.model, config.openai.maxOutputTokens, config.maxAgentSteps, logger);
  return new BotBrain(database, runtime, threads, memoryBuilder, logger, clock);
}
