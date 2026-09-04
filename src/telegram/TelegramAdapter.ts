import { DateTime } from 'luxon';
import type { Api } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { EventStatus } from '../types/domain.js';

export type DisplayEvent = {
  id: number;
  title: string;
  dateFrom: string;
  dateTo: string | null;
  time: string | null;
};

export type DisplayNotification = {
  id: number;
  remindAt: string;
  status: 'pending' | 'sent' | 'cancelled';
};

export type DisplayScheduleEvent = DisplayEvent & {
  status: EventStatus;
  completedAt: string | null;
  notifications: DisplayNotification[];
};

export type FormattedTelegramMessage = {
  text: string;
  entities: MessageEntity[];
};

type EventSegment = FormattedTelegramMessage;

export interface TelegramGateway {
  sendMessage(chatId: number, text: string): Promise<string>;
  sendEventReminder(
    chatId: number,
    event: DisplayEvent,
    now: string,
    firstName: string,
  ): Promise<string>;
  sendEventList(
    chatId: number,
    title: string,
    events: DisplayScheduleEvent[],
    now: string,
    firstName: string,
  ): Promise<string>;
}

const TELEGRAM_MESSAGE_LIMIT = 4096;

function formatDate(date: string, includeYear: boolean): string {
  const parsed = DateTime.fromISO(date, { zone: 'utc' }).setLocale('ru');
  return parsed.toFormat(includeYear ? 'd MMMM yyyy' : 'd MMMM');
}

function formatRange(event: DisplayEvent, currentYear: number): string {
  const start = DateTime.fromISO(event.dateFrom, { zone: 'utc' }).setLocale('ru');
  const end = event.dateTo
    ? DateTime.fromISO(event.dateTo, { zone: 'utc' }).setLocale('ru')
    : null;

  if (!end) {
    return formatDate(event.dateFrom, start.year !== currentYear);
  }

  if (start.year === end.year && start.month === end.month) {
    const year = start.year === currentYear ? '' : ` ${start.year}`;
    return `${start.day}–${end.day} ${end.toFormat('MMMM')}${year}`;
  }

  if (start.year === end.year) {
    const year = start.year === currentYear ? '' : ` ${start.year}`;
    return `${start.toFormat('d MMMM')} — ${end.toFormat('d MMMM')}${year}`;
  }

  return `${start.toFormat('d MMMM yyyy')} — ${end.toFormat('d MMMM yyyy')}`;
}

function normalizeName(firstName: string): string {
  return firstName.trim().replace(/\s+/g, ' ');
}

export function formatEventBlock(
  event: DisplayEvent,
  currentYear: number,
  firstName: string,
): string {
  const time = event.time === null ? '' : `, ${event.time}`;
  return `${formatRange(event, currentYear)}${time}\n${normalizeName(firstName)} — ${event.title}`;
}

function formatNotification(
  notification: DisplayNotification,
  currentYear: number,
): string {
  const parsed = DateTime.fromISO(notification.remindAt, { zone: 'utc' }).setLocale('ru');
  const date = parsed.toFormat(parsed.year === currentYear ? 'd MMMM' : 'd MMMM yyyy');
  const status =
    notification.status === 'sent'
      ? ' (отправлено)'
      : notification.status === 'cancelled'
        ? ' (отменено)'
        : '';

  return `— ${date}, ${parsed.toFormat('HH:mm')}${status}`;
}

function formatEventSegments(
  event: DisplayScheduleEvent,
  currentYear: number,
  firstName: string,
  maxLength: number,
): EventSegment[] {
  const eventHeader = formatEventBlock(event, currentYear, firstName);
  const headerEntities: MessageEntity[] = event.status === 'completed'
    ? [{ type: 'strikethrough', offset: 0, length: eventHeader.length }]
    : [];

  if (event.notifications.length === 0) {
    return [{ text: eventHeader, entities: headerEntities }];
  }

  const segments: EventSegment[] = [];
  let current = `${eventHeader}\nНапоминания:`;

  for (const notification of event.notifications) {
    const line = formatNotification(notification, currentYear);
    const candidate = `${current}\n${line}`;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    segments.push({ text: current, entities: headerEntities });
    current = `${eventHeader}\nНапоминания (продолжение):\n${line}`;
  }

  segments.push({ text: current, entities: headerEntities });
  return segments;
}

export function formatEventListMessages(
  title: string,
  events: DisplayScheduleEvent[],
  now: string,
  firstName: string,
): FormattedTelegramMessage[] {
  const currentYear = DateTime.fromISO(now, { setZone: true }).year;

  if (events.length === 0) {
    return [{ text: `${title}\n\nСобытий нет.`, entities: [] }];
  }

  const chunks: FormattedTelegramMessage[] = [];
  let current: FormattedTelegramMessage = { text: title, entities: [] };
  const continuationTitle = `${title} (продолжение)`;
  const maxSegmentLength = TELEGRAM_MESSAGE_LIMIT - continuationTitle.length - 2;

  for (const event of events) {
    const segments = formatEventSegments(event, currentYear, firstName, maxSegmentLength);

    for (const segment of segments) {
      const separator = '\n\n';
      const candidate = `${current.text}${separator}${segment.text}`;

      if (candidate.length <= TELEGRAM_MESSAGE_LIMIT) {
        const segmentOffset = current.text.length + separator.length;
        current = {
          text: candidate,
          entities: [
            ...current.entities,
            ...segment.entities.map((entity) => ({
              ...entity,
              offset: entity.offset + segmentOffset,
            })),
          ],
        };
        continue;
      }

      chunks.push(current);
      const segmentOffset = continuationTitle.length + separator.length;
      current = {
        text: `${continuationTitle}${separator}${segment.text}`,
        entities: segment.entities.map((entity) => ({
          ...entity,
          offset: entity.offset + segmentOffset,
        })),
      };
    }
  }

  chunks.push(current);
  return chunks;
}

export function formatEventList(
  title: string,
  events: DisplayScheduleEvent[],
  now: string,
  firstName: string,
): string[] {
  return formatEventListMessages(title, events, now, firstName).map((message) => message.text);
}

export function formatEventReminder(
  event: DisplayEvent,
  now: string,
  firstName: string,
): string {
  const currentYear = DateTime.fromISO(now, { setZone: true }).year;
  return `Напоминание\n\n${formatEventBlock(event, currentYear, firstName)}`;
}

export class TelegramAdapter implements TelegramGateway {
  public constructor(private readonly api: Api) {}

  public async sendMessage(chatId: number, text: string): Promise<string> {
    await this.api.sendMessage(chatId, text);
    return text;
  }

  public async sendEventReminder(
    chatId: number,
    event: DisplayEvent,
    now: string,
    firstName: string,
  ): Promise<string> {
    const text = formatEventReminder(event, now, firstName);
    await this.api.sendMessage(chatId, text);
    return text;
  }

  public async sendEventList(
    chatId: number,
    title: string,
    events: DisplayScheduleEvent[],
    now: string,
    firstName: string,
  ): Promise<string> {
    const messages = formatEventListMessages(title, events, now, firstName);

    for (const message of messages) {
      await this.api.sendMessage(
        chatId,
        message.text,
        message.entities.length > 0 ? { entities: message.entities } : undefined,
      );
    }

    return messages.map((message) => message.text).join('\n\n');
  }
}
