import { DateTime } from 'luxon';
import { z } from 'zod';
import type { MemoryContext } from '../application/memory/MemoryContextBuilder.js';

export type ChatMemberReference = {
  telegramUserId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
};

export type AgentContext = {
  userId: number | null;
  chatId: number;
  threadId: number;
  memory?: MemoryContext;
  sourceMessageId?: number;
  chatType: ChatType;
  chatTitle: string | null;
  telegramUserId: number | null;
  telegramChatId: number;
  telegramChatType: TelegramChatType;
  firstName: string | null;
  displayName: string | null;
  telegramUsername: string | null;
  userPreferences: string | null;
  timezone: string;
  now: string;
  trigger?: AgentTrigger | undefined;
  groupMessage?: {
    directlyAddressed: boolean;
  } | undefined;
  replyTo?: { messageId: number; author: string; text: string | null; quote: string | null; sentAt: string } | null | undefined;
  mentionRecipient?: { id: number; firstName: string } | undefined;
  recipientReferences?: ChatMemberReference[];
  resolvedChatMembers?: ChatMemberReference[];
  beforeStep?: () => Promise<void>;
  beforeSend?: () => Promise<void>;
  outgoingMessageId?: number;
};

export type AgentTrigger =
  | { kind: 'agent_task'; notificationId: number; instruction: string; scheduledFor: string;
      timezone: string; scheduleId: number | null; eventId: number | null }
  | { kind: 'notification'; notificationId: number; eventId: number; deadlineVersion: number;
      notificationKind: 'reminder' | 'completion_check' | 'readiness_response'; answer: boolean | null }
  | { kind: 'reschedule_reply'; eventId: number; deadlineVersion: number }
  | { kind: 'service'; reason: string };

export type User = {
  id: number;
  telegramUserId: number;
  telegramChatId: number | null;
  telegramUsername: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
  timezone: string;
};

export type ChatType = 'personal' | 'group';
export type TelegramChatType = 'private' | 'group' | 'supergroup';

export type Chat = {
  id: number;
  type: ChatType;
  userId: number | null;
  telegramChatId: number | null;
  title: string | null;
  timezone: string;
};

export const eventStatusSchema = z.enum(['active', 'completed', 'deleted']);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const utcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/)
  .refine((value) => DateTime.fromISO(value, { zone: 'utc' }).isValid, 'Must be a UTC timestamp');

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = DateTime.fromISO(value, { zone: 'utc' });
  return parsed.isValid && parsed.toISODate() === value;
}, 'Must be a real calendar date in YYYY-MM-DD format');

export const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Must use HH:mm in 24-hour time');

export const eventSchema = z.object({
  id: z.number().int().positive().safe(),
  title: z.string(),
  description: z.string().nullable(),
  dateFrom: isoDateSchema.nullable(),
  dateTo: isoDateSchema.nullable(),
  time: localTimeSchema.nullable(),
  status: eventStatusSchema,
  completedAt: utcDateTimeSchema.nullable(),
  deadlineVersion: z.number().int().positive(),
  reminderMode: z.enum(['legacy', 'default', 'custom', 'off']),
  checkCompletion: z.boolean(),
  reminderRecipientUserId: z.number().int().positive().safe().nullable(),
  recipientVersion: z.number().int().positive(),
});

export type EventDto = z.infer<typeof eventSchema>;

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};
