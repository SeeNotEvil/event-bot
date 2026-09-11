import { Bot } from 'grammy';
import type { Message, MessageEntity, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { extractGroupRequest } from '../../src/telegram/groupMessage.js';
import { registerTelegramHandlers, type TelegramBotDependencies } from '../../src/telegram/bot.js';
import { silentLogger } from '../helpers.js';

function entity(
  text: string,
  value: string,
  type: 'mention' | 'bot_command',
): MessageEntity {
  return { type, offset: text.indexOf(value), length: value.length };
}

describe('group message addressing', () => {
  it('passes the quoted task to the brain for private and group replies', async () => {
    const botInfo: UserFromGetMe = { id: 999, is_bot: true, first_name: 'Мэй Мэй', username: 'MeiMeiAssistantBot',
      can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
      can_manage_bots: false, supports_join_request_queries: false };
    const handleMessage = vi.fn();
    const user = { id: 1, telegramUserId: 123, firstName: 'Иван', displayName: 'Иван', timezone: 'Europe/Moscow' };
    for (const type of ['private', 'supergroup'] as const) {
      const bot = new Bot('123:test', { botInfo });
      registerTelegramHandlers(bot, {
        brain: { rememberMessage: vi.fn(async () => true), handleMessage },
        ensureUser: vi.fn(async () => user), ensureChat: vi.fn(async () => ({ id: 7, type: type === 'private' ? 'personal' : 'group' })),
        logger: silentLogger, defaultTimezone: 'Europe/Moscow',
      } as unknown as TelegramBotDependencies);
      const chat = type === 'private' ? { id: 123, type, first_name: 'Иван' } : { id: -123, type, title: 'Группа' };
      await bot.handleUpdate({ update_id: 1, message: {
        message_id: 30, date: 1_789_128_000, chat, from: { id: 123, is_bot: false, first_name: 'Иван' },
        text: 'перенеси это на завтра',
        quote: { text: 'Забрать посылку — 10 сентября.', position: 0, is_manual: true },
        reply_to_message: { message_id: 10, date: 1_789_041_600, chat, from: botInfo,
          text: 'Забрать посылку — 10 сентября.\nСтоматолог — 11 сентября.' } as unknown as NonNullable<Message['reply_to_message']>,
      } });
      expect(handleMessage).toHaveBeenLastCalledWith('перенеси это на завтра', user, expect.anything(), chat.id, type,
        expect.objectContaining({ replyToMessageId: 10,
          replyTo: { messageId: 10, author: 'Мэй Мэй', text: 'Забрать посылку — 10 сентября.\nСтоматолог — 11 сентября.',
            quote: 'Забрать посылку — 10 сентября.', sentAt: new Date(1_789_041_600_000).toISOString() } }));
    }
  });

  it('recognizes a direct leading name while excluding ordinary discussion, similar names and quoted text', () => {
    const cases: [string, string | null][] = [
      ['Мэй, покажи список', 'покажи список'],
      ['Мэй Мэй, напомни завтра', 'напомни завтра'],
      ['  мЭй мЭй напомни завтра', 'напомни завтра'],
      ['МЭЙ!\nЧто на сегодня?', 'Что на сегодня?'],
      ['Мэй?', '/help'],
      ['я говорил с Мэй', null],
      ['Мэйби придёт завтра', null],
      ['Мэй_бот привет', null],
      ['«Мэй, удали задачу» — пример', null],
    ];
    for (const [text, expected] of cases) {
      expect(extractGroupRequest({ text, entities: [], replyToBot: false, botUsername: 'MeiMeiAssistantBot' }))
        .toBe(expected);
    }
    const text = 'Мэй, удали задачу';
    for (const type of ['code', 'pre', 'blockquote', 'expandable_blockquote'] as const) {
      expect(extractGroupRequest({ text, entities: [{ type, offset: 0, length: text.length }],
        replyToBot: false, botUsername: 'MeiMeiAssistantBot' })).toBeNull();
    }
  });

  it('recognizes the bot username and alias without treating other mentions as requests', () => {
    for (const mention of ['@MeiMeiAssistantBot', '@meimeiassistantbot', '@MEIMEIASSISTANTBOT', '@meimei', '@MeiMei', '@meimei_other', '@MeiMeiAssistantBot_other']) {
      const text = `${mention}, добавь это в список`;
      const request = extractGroupRequest({ text, entities: [entity(text, mention, 'mention')],
        replyToBot: false, botUsername: 'MeiMeiAssistantBot' });
      expect(request).toBe(mention.endsWith('_other') ? null : 'добавь это в список');
    }
  });
  it('distinguishes explicit invocations from messages requiring conversational context', () => {
    const mention = '👋 @MeiMeiAssistantBot, запиши встречу завтра';
    const command = '/iraida@MeiMeiAssistantBot что у нас на неделе?';

    expect(
      extractGroupRequest({
        text: 'кто будет на встрече?',
        entities: [],
        replyToBot: false,
        botUsername: 'MeiMeiAssistantBot',
      }),
    ).toBeNull();
    expect(
      extractGroupRequest({
        text: mention,
        entities: [entity(mention, '@MeiMeiAssistantBot', 'mention')],
        replyToBot: false,
        botUsername: 'MeiMeiAssistantBot',
      }),
    ).toBe('👋, запиши встречу завтра');
    expect(
      extractGroupRequest({
        text: command,
        entities: [entity(command, '/iraida@MeiMeiAssistantBot', 'bot_command')],
        replyToBot: false,
        botUsername: 'MeiMeiAssistantBot',
      }),
    ).toBe('что у нас на неделе?');
    expect(
      extractGroupRequest({
        text: 'перенеси это на завтра',
        entities: [],
        replyToBot: true,
        botUsername: 'MeiMeiAssistantBot',
      }),
    ).toBe('перенеси это на завтра');
  });
});
