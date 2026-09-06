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
  it('recognizes the bot username and alias without treating other mentions as requests', () => {
    for (const mention of ['@MeiMeiAssistantBot', '@meimeiassistantbot', '@MEIMEIASSISTANTBOT', '@meimei', '@MeiMei', '@meimei_other', '@MeiMeiAssistantBot_other']) {
      const text = `${mention}, добавь это в список`;
      const request = extractGroupRequest({ text, entities: [entity(text, mention, 'mention')],
        replyToBot: false, botUsername: 'MeiMeiAssistantBot' });
      expect(request).toBe(mention.endsWith('_other') ? null : 'добавь это в список');
    }
  });
  it('ignores ambient chat and extracts supported invocations', () => {
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
