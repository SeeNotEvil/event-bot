import { DateTime } from 'luxon';
import { z } from 'zod';

export type AgentContext = {
  userId: number;
  telegramUserId: number;
  telegramChatId: number;
  firstName: string;
  displayName: string;
  telegramUsername: string | null;
  timezone: string;
  now: string;
};

export type User = {
  id: number;
  telegramUserId: number;
  telegramChatId: number;
  telegramUsername: string | null;
  firstName: string;
  lastName: string | null;
  displayName: string;
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
  dateFrom: isoDateSchema,
  dateTo: isoDateSchema.nullable(),
  time: localTimeSchema.nullable(),
  status: eventStatusSchema,
  completedAt: utcDateTimeSchema.nullable(),
});

export type EventDto = z.infer<typeof eventSchema>;

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};
