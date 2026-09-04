import { DateTime } from 'luxon';
import { z } from 'zod';

const LOCAL_DATE_TIME_FORMAT = "yyyy-MM-dd'T'HH:mm";

export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine((value) => {
    const parsed = DateTime.fromFormat(value, LOCAL_DATE_TIME_FORMAT, { zone: 'utc' });
    return parsed.isValid && parsed.toFormat(LOCAL_DATE_TIME_FORMAT) === value;
  }, 'Must be a real local date and time in YYYY-MM-DDTHH:mm format');

export const notificationStatusSchema = z.enum(['pending', 'sent', 'cancelled']);

export const notificationSchema = z.object({
  id: z.number().int().positive().safe(),
  eventId: z.number().int().positive().safe(),
  eventTitle: z.string(),
  remindAt: localDateTimeSchema,
  timezone: z.string().min(1).max(64),
  status: notificationStatusSchema,
});

export type NotificationDto = z.infer<typeof notificationSchema>;

export const createNotificationInputSchema = z.object({
  eventId: z.number().int().positive().safe(),
  remindAt: localDateTimeSchema,
});

export type CreateNotificationInput = z.infer<typeof createNotificationInputSchema>;

export const createNotificationOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    created: z.boolean(),
    notification: notificationSchema,
  }),
  z.object({
    success: z.literal(false),
    created: z.literal(false),
    notification: z.null(),
    reason: z.enum([
      'EVENT_NOT_FOUND_OR_INACTIVE',
      'REMINDER_NOT_IN_FUTURE',
      'INVALID_LOCAL_TIME',
    ]),
  }),
]);

export type CreateNotificationOutput = z.infer<typeof createNotificationOutputSchema>;

export const searchNotificationsInputSchema = z
  .object({
    eventId: z.number().int().positive().safe().nullable(),
    statuses: z.array(notificationStatusSchema).min(1).max(3).nullable(),
    remindFrom: localDateTimeSchema.nullable(),
    remindTo: localDateTimeSchema.nullable(),
    limit: z.number().int().min(1).max(100).nullable(),
  })
  .refine(
    (input) =>
      input.remindFrom === null ||
      input.remindTo === null ||
      input.remindTo >= input.remindFrom,
    {
      path: ['remindTo'],
      message: 'remindTo must not be earlier than remindFrom',
    },
  );

export type SearchNotificationsInput = z.infer<typeof searchNotificationsInputSchema>;

export const searchNotificationsOutputSchema = z.object({
  notifications: z.array(notificationSchema),
});

export type SearchNotificationsOutput = z.infer<typeof searchNotificationsOutputSchema>;

export const deleteNotificationInputSchema = z.object({
  notificationId: z.number().int().positive().safe(),
});

export type DeleteNotificationInput = z.infer<typeof deleteNotificationInputSchema>;

export const deleteNotificationOutputSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    notification: notificationSchema.extend({ status: z.literal('cancelled') }),
  }),
  z.object({
    success: z.literal(false),
    notification: z.null(),
    reason: z.literal('NOT_FOUND_OR_NOT_PENDING'),
  }),
]);

export type DeleteNotificationOutput = z.infer<typeof deleteNotificationOutputSchema>;
