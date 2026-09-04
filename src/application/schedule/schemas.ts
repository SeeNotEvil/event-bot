import { z } from 'zod';
import { eventSchema, eventStatusSchema, isoDateSchema } from '../../types/domain.js';
import {
  localDateTimeSchema,
  notificationSchema,
  notificationStatusSchema,
} from '../notifications/schemas.js';

export const searchScheduleInputSchema = z
  .object({
    query: z.string().trim().min(1).max(255).nullable(),
    eventStatuses: z.array(eventStatusSchema).min(1).max(3).nullable(),
    eventDateFrom: isoDateSchema.nullable(),
    eventDateTo: isoDateSchema.nullable(),
    reminderStatuses: z.array(notificationStatusSchema).min(1).max(3).nullable(),
    reminderFrom: localDateTimeSchema.nullable(),
    reminderTo: localDateTimeSchema.nullable(),
    requireReminder: z.boolean(),
    limit: z.number().int().min(1).max(100).nullable(),
  })
  .refine(
    (input) =>
      input.eventDateFrom === null ||
      input.eventDateTo === null ||
      input.eventDateTo >= input.eventDateFrom,
    {
      path: ['eventDateTo'],
      message: 'eventDateTo must not be earlier than eventDateFrom',
    },
  )
  .refine(
    (input) =>
      input.reminderFrom === null ||
      input.reminderTo === null ||
      input.reminderTo >= input.reminderFrom,
    {
      path: ['reminderTo'],
      message: 'reminderTo must not be earlier than reminderFrom',
    },
  );

export type SearchScheduleInput = z.infer<typeof searchScheduleInputSchema>;

export const scheduleEventSchema = eventSchema.extend({
  notifications: z.array(notificationSchema),
});

export type ScheduleEvent = z.infer<typeof scheduleEventSchema>;

export const searchScheduleOutputSchema = z.object({
  events: z.array(scheduleEventSchema).max(100),
});

export type SearchScheduleOutput = z.infer<typeof searchScheduleOutputSchema>;
