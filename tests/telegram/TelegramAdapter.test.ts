import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  formatEventReminder,
  formatEventList,
  formatEventListMessages,
  TelegramAdapter,
  type DisplayScheduleEvent,
} from '../../src/telegram/TelegramAdapter.js';

describe('TelegramAdapter formatting', () => {
  it('formats single dates, ranges, times and years in Russian', () => {
    const chunks = formatEventList(
      'Ближайшие события',
      [
        {
          id: 1,
          title: 'Стоматолог',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: '18:00',
          status: 'active',
          completedAt: null,
          createdByName: 'Ксюша',
          notifications: [
            {
              id: 10,
              remindAt: '2026-09-11T12:00',
              status: 'pending',
            },
          ],
        },
        {
          id: 2,
          title: 'Забрать документы',
          dateFrom: '2026-09-15',
          dateTo: '2026-09-18',
          time: null,
          status: 'active',
          completedAt: null,
          createdByName: 'Ксюша',
          notifications: [],
        },
        {
          id: 3,
          title: 'Конференция',
          dateFrom: '2027-01-02',
          dateTo: null,
          time: null,
          status: 'active',
          completedAt: null,
          createdByName: 'Ксюша',
          notifications: [],
        },
      ],
      '2026-09-04T21:30:00+03:00',
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('12 сентября, 18:00\nКсюша — Стоматолог');
    expect(chunks[0]).toContain('Напоминания:\n— 11 сентября, 12:00');
    expect(chunks[0]).toContain('15–18 сентября\nКсюша — Забрать документы');
    expect(chunks[0]).toContain('2 января 2027\nКсюша — Конференция');
  });

  it('renders an empty state', () => {
    expect(
      formatEventList('Мои события', [], '2026-09-04T21:30:00+03:00'),
    ).toEqual(['Мои события\n\nСобытий нет.']);
  });

  it('normalizes whitespace in the Telegram first name', () => {
    const [message] = formatEventList(
      'События',
      [
        {
          id: 1,
          title: 'Стоматолог',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: null,
          status: 'active',
          completedAt: null,
          createdByName: '  Ксюша\n  Анна  ',
          notifications: [],
        },
      ],
      '2026-09-04T21:30:00+03:00',
    );

    expect(message).toContain('Ксюша Анна — Стоматолог');
  });

  it('formats a server-owned reminder without Telegram markup', () => {
    expect(
      formatEventReminder(
        {
          id: 17,
          title: 'Стоматолог',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: '18:00',
        },
        '2026-09-05T12:00:00+03:00',
        'Ксюша',
      ),
    ).toBe('Напоминание\n\n12 сентября, 18:00\nКсюша — Стоматолог');
  });

  it('splits a long reminder list without breaking Telegram limits', () => {
    const notifications = Array.from({ length: 250 }, (_, index) => {
      const day = 10 + Math.floor(index / 24);
      const hour = index % 24;
      return {
        id: index + 1,
        remindAt: `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00`,
        status: 'pending' as const,
      };
    });
    const chunks = formatEventList(
      'События',
      [
        {
          id: 1,
          title: 'Большое событие',
          dateFrom: '2026-09-20',
          dateTo: null,
          time: '18:00',
          status: 'active',
          completedAt: null,
          createdByName: 'Ксюша',
          notifications,
        },
      ],
      '2026-09-04T21:30:00+03:00',
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toContain('Напоминания (продолжение):');
    expect(chunks.join('\n')).toContain('— 20 сентября, 09:00');
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('chunks long lists and sends each chunk without Telegram markup', async () => {
    const sendMessage = vi.fn(async (_chatId: number, _text: string) => ({ message_id: 1 }));
    const api = { sendMessage } as unknown as Api;
    const adapter = new TelegramAdapter(api);
    const events: DisplayScheduleEvent[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      title: `Событие ${index + 1} ${'я'.repeat(200)}`,
      dateFrom: '2026-09-12',
      dateTo: null,
      time: null,
      status: 'active' as const,
      completedAt: null,
      createdByName: 'Ксюша',
      notifications: [],
    }));

    const transcript = await adapter.sendEventList(
      123,
      'События',
      events,
      '2026-09-04T21:30:00+03:00',
    );

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [, text] of sendMessage.mock.calls) {
      expect(String(text).length).toBeLessThanOrEqual(4096);
    }
    expect(transcript).toContain('Событие 100');
  });

  it('strikes the complete date and title block using Telegram entities', () => {
    const [message] = formatEventListMessages(
      'Выполненные события',
      [
        {
          id: 17,
          title: 'Стоматолог 👩‍⚕️',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: '18:00',
          status: 'completed',
          completedAt: '2026-09-12T16:00:00.000Z',
          createdByName: 'Ксюша',
          notifications: [],
        },
      ],
      '2026-09-04T21:30:00+03:00',
    );

    expect(message).toBeDefined();
    const expectedBlock = '12 сентября, 18:00\nКсюша — Стоматолог 👩‍⚕️';
    const offset = message!.text.indexOf(expectedBlock);
    expect(message!.entities).toEqual([
      {
        type: 'strikethrough',
        offset,
        length: expectedBlock.length,
      },
    ]);
    expect(message!.text).not.toContain('<s>');
    expect(message!.text).not.toContain('~~');
  });

  it('sends strikethrough entities while returning a plain transcript', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const adapter = new TelegramAdapter({ sendMessage } as unknown as Api);

    const transcript = await adapter.sendEventList(
      123,
      'Выполненные события',
      [
        {
          id: 17,
          title: 'Стоматолог',
          dateFrom: '2026-09-12',
          dateTo: null,
          time: null,
          status: 'completed',
          completedAt: '2026-09-12T16:00:00.000Z',
          createdByName: 'Ксюша',
          notifications: [],
        },
      ],
      '2026-09-04T21:30:00+03:00',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining('12 сентября\nКсюша — Стоматолог'),
      {
        entities: [expect.objectContaining({ type: 'strikethrough' })],
      },
    );
    expect(transcript).toContain('12 сентября\nКсюша — Стоматолог');
    expect(transcript).not.toContain('<s>');
  });
});
