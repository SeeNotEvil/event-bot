import type { MessageEntity } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { extractGroupRequest } from '../../src/telegram/groupMessage.js';

function entity(
  text: string,
  value: string,
  type: 'mention' | 'bot_command',
): MessageEntity {
  return { type, offset: text.indexOf(value), length: value.length };
}

describe('group message addressing', () => {
  it('recognizes the exact meimei alias without treating other mentions as requests', () => {
    for (const alias of ['@meimei', '@MeiMei', '@meimei_other']) {
      const text = `${alias}, добавь это в список`;
      const request = extractGroupRequest({ text, entities: [entity(text, alias, 'mention')],
        replyToBot: false, botUsername: 'iraida_deadline_bot' });
      expect(request).toBe(alias === '@meimei_other' ? null : 'добавь это в список');
    }
  });
  it('ignores ambient chat and extracts supported invocations', () => {
    const mention = '👋 @iraida_deadline_bot, запиши встречу завтра';
    const command = '/iraida@iraida_deadline_bot что у нас на неделе?';

    expect(
      extractGroupRequest({
        text: 'кто будет на встрече?',
        entities: [],
        replyToBot: false,
        botUsername: 'iraida_deadline_bot',
      }),
    ).toBeNull();
    expect(
      extractGroupRequest({
        text: mention,
        entities: [entity(mention, '@iraida_deadline_bot', 'mention')],
        replyToBot: false,
        botUsername: 'iraida_deadline_bot',
      }),
    ).toBe('👋, запиши встречу завтра');
    expect(
      extractGroupRequest({
        text: command,
        entities: [entity(command, '/iraida@iraida_deadline_bot', 'bot_command')],
        replyToBot: false,
        botUsername: 'iraida_deadline_bot',
      }),
    ).toBe('что у нас на неделе?');
    expect(
      extractGroupRequest({
        text: 'перенеси это на завтра',
        entities: [],
        replyToBot: true,
        botUsername: 'iraida_deadline_bot',
      }),
    ).toBe('перенеси это на завтра');
  });
});
