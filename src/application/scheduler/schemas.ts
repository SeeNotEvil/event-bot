import { z } from 'zod';
import { localTimeSchema } from '../../types/domain.js';
import { localDateTimeSchema } from '../notifications/schemas.js';

export const schedulerIdSchema = z.number().int().positive().safe();
export const agentTaskPayloadSchema = z.object({ instruction: z.string().trim().min(1).max(8_000) });
export const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly']), time: localTimeSchema,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, 'Duplicate weekdays').nullable(),
}).refine((value) => (value.frequency === 'weekly') === (value.weekdays !== null),
  'weekdays must be provided for weekly and null for daily');
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const createScheduleSchema = z.object({
  instruction: agentTaskPayloadSchema.shape.instruction, recurrence: recurrenceSchema,
  eventId: schedulerIdSchema.nullable(),
});
export const updateScheduleSchema = createScheduleSchema.extend({
  scheduleId: schedulerIdSchema, expectedVersion: schedulerIdSchema, enabled: z.boolean(),
});
export const deleteScheduleSchema = z.object({ scheduleId: schedulerIdSchema, expectedVersion: schedulerIdSchema });
export const searchSchedulesSchema = z.object({
  scheduleId: schedulerIdSchema.nullable(), enabled: z.boolean().nullable(),
  beforeId: schedulerIdSchema.nullable(), limit: z.number().int().min(1).max(100).nullable(),
});
export const scheduleSchema = z.object({
  id: schedulerIdSchema, eventId: schedulerIdSchema.nullable(), kind: z.literal('agent_task'),
  instruction: agentTaskPayloadSchema.shape.instruction, recurrence: recurrenceSchema, timezone: z.string(),
  enabled: z.boolean(), version: schedulerIdSchema,
  nextUnqueuedAt: localDateTimeSchema.nullable(), nextNotificationAt: localDateTimeSchema.nullable(),
});
export const schedulePageSchema = z.object({ schedules: z.array(scheduleSchema), nextBeforeId: schedulerIdSchema.nullable() });
export const scheduleResultSchema = z.object({ success: z.boolean(),
  reason: z.enum(['NOT_FOUND', 'VERSION_CONFLICT']).nullable(), schedule: scheduleSchema.nullable() });
export const scheduleOnceSchema = z.object({
  instruction: agentTaskPayloadSchema.shape.instruction, remindAt: localDateTimeSchema,
  eventId: schedulerIdSchema.nullable(),
});

// mysql2 decodes JSON columns; this also accepts serialized values from migrations/adapters.
export function decodeJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}
