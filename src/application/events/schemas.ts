import { z } from 'zod';
import {
  eventSchema,
  eventStatusSchema,
  isoDateSchema,
  localTimeSchema,
} from '../../types/domain.js';
import {
  localDateTimeSchema,
  notificationSchema,
} from '../notifications/schemas.js';

const eventIdSchema = z.number().int().positive().safe();

export const createEventInputSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1).max(65_535).nullable(),
    dateFrom: isoDateSchema,
    dateTo: isoDateSchema.nullable(),
    time: localTimeSchema.nullable(),
  })
  .refine((input) => input.dateTo === null || input.dateTo >= input.dateFrom, {
    path: ['dateTo'],
    message: 'dateTo must not be earlier than dateFrom',
  });

export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const createEventsInputSchema = z
  .object({
    events: z.array(createEventInputSchema).min(1).max(100),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();

    input.events.forEach((event, index) => {
      const fingerprint = JSON.stringify([
        event.title,
        event.description,
        event.dateFrom,
        event.dateTo,
        event.time,
      ]);

      if (seen.has(fingerprint)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index],
          message: 'Exact duplicate events require clarification',
        });
      }

      seen.add(fingerprint);
    });
  });

export type CreateEventsInput = z.infer<typeof createEventsInputSchema>;

export const createEventsOutputSchema = z.object({
  createdCount: z.number().int().min(1).max(100),
  dateRange: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
  }),
  events: z.array(eventSchema).min(1).max(100),
});

export type CreateEventsOutput = z.infer<typeof createEventsOutputSchema>;

export const searchEventsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(255).nullable(),
    statuses: z.array(eventStatusSchema).min(1).max(3).nullable(),
    dateFrom: isoDateSchema.nullable(),
    dateTo: isoDateSchema.nullable(),
    limit: z.number().int().min(1).max(100).nullable(),
  })
  .refine(
    (input) => input.dateFrom === null || input.dateTo === null || input.dateTo >= input.dateFrom,
    {
      path: ['dateTo'],
      message: 'dateTo must not be earlier than dateFrom',
    },
  );

export type SearchEventsInput = z.infer<typeof searchEventsInputSchema>;

export const searchEventsOutputSchema = z.object({
  events: z.array(eventSchema),
});

export const deleteEventInputSchema = z.object({
  eventId: eventIdSchema,
});

export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;

export const deleteEventOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    event: z.object({
      id: z.number().int().positive().safe(),
      title: z.string(),
      status: z.literal('deleted'),
    }),
  }),
  z.object({
    success: z.literal(false),
    event: z.null(),
    reason: z.literal('NOT_FOUND_OR_INACTIVE'),
  }),
]);

export type DeleteEventOutput = z.infer<typeof deleteEventOutputSchema>;

export const deleteEventsInputSchema = z.object({
  eventIds: z
    .array(eventIdSchema)
    .min(2)
    .max(100)
    .refine((eventIds) => new Set(eventIds).size === eventIds.length, {
      message: 'eventIds must be unique',
    }),
});

export type DeleteEventsInput = z.infer<typeof deleteEventsInputSchema>;

const deletedEventSchema = z.object({
  id: eventIdSchema,
  title: z.string(),
  status: z.literal('deleted'),
});

export const deleteEventsOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    deletedCount: z.number().int().min(2).max(100),
    events: z.array(deletedEventSchema).min(2).max(100),
  }),
  z.object({
    success: z.literal(false),
    deletedCount: z.literal(0),
    events: z.array(deletedEventSchema).max(0),
    reason: z.literal('NOT_FOUND_OR_INACTIVE'),
    missingEventIds: z.array(eventIdSchema).min(1).max(100),
  }),
]);

export type DeleteEventsOutput = z.infer<typeof deleteEventsOutputSchema>;

export const completeEventInputSchema = z.object({
  eventId: eventIdSchema,
});

export type CompleteEventInput = z.infer<typeof completeEventInputSchema>;

const completedEventSchema = eventSchema.extend({
  status: z.literal('completed'),
  completedAt: z.string().datetime({ offset: true }),
});

export const completeEventOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    changed: z.boolean(),
    event: completedEventSchema,
    cancelledNotificationCount: z.number().int().min(0),
  }),
  z.object({
    success: z.literal(false),
    changed: z.literal(false),
    event: z.null(),
    cancelledNotificationCount: z.literal(0),
    reason: z.literal('EVENT_NOT_FOUND_OR_NOT_COMPLETABLE'),
  }),
]);

export type CompleteEventOutput = z.infer<typeof completeEventOutputSchema>;

export const rescheduleEventInputSchema = z
  .object({
    eventId: eventIdSchema,
    dateFrom: isoDateSchema,
    dateTo: isoDateSchema.nullable(),
    time: localTimeSchema.nullable(),
    reminderTimes: z
      .array(localDateTimeSchema)
      .max(20)
      .refine((reminderTimes) => new Set(reminderTimes).size === reminderTimes.length, {
        message: 'reminderTimes must be unique',
      }),
  })
  .refine((input) => input.dateTo === null || input.dateTo >= input.dateFrom, {
    path: ['dateTo'],
    message: 'dateTo must not be earlier than dateFrom',
  });

export type RescheduleEventInput = z.infer<typeof rescheduleEventInputSchema>;

export const rescheduleEventFailureReasonSchema = z.enum([
  'EVENT_NOT_FOUND_OR_INACTIVE',
  'INVALID_LOCAL_TIME',
  'REMINDER_NOT_IN_FUTURE',
  'REMINDER_TIME_ALREADY_SENT',
]);

export type RescheduleEventFailureReason = z.infer<
  typeof rescheduleEventFailureReasonSchema
>;

const activeEventSchema = eventSchema.extend({ status: z.literal('active') });
const pendingNotificationSchema = notificationSchema.extend({
  status: z.literal('pending'),
});

export const rescheduleEventOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    changed: z.boolean(),
    event: activeEventSchema,
    notifications: z.array(pendingNotificationSchema).max(20),
    cancelledNotificationCount: z.number().int().min(0),
  }),
  z.object({
    success: z.literal(false),
    changed: z.literal(false),
    event: z.null(),
    notifications: z.array(pendingNotificationSchema).max(0),
    cancelledNotificationCount: z.literal(0),
    reason: rescheduleEventFailureReasonSchema,
  }),
]);

export type RescheduleEventOutput = z.infer<typeof rescheduleEventOutputSchema>;
