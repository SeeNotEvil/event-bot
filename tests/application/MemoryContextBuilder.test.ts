import { describe, expect, it } from 'vitest';
import { MemoryContextBuilder } from '../../src/application/memory/MemoryContextBuilder.js';
import type { Memory, MemoryStore } from '../../src/application/memory/MemoryStore.js';
import type { ThreadMemory } from '../../src/application/memory/ThreadMemory.js';

describe('MemoryContextBuilder', () => {
  it('keeps reply branches and message dates while including each saved memory only once', async () => {
    const profile: Memory = { id: 1, key: 'profile', kind: 'procedural', content: 'Обращайся на ты', version: 1,
      source: 'addressed_message', sourceMessageId: null, updatedAt: '2026-09-10T12:00:00.000Z' };
    const rule: Memory = { ...profile, id: 2, key: 'work', content: 'Встречи по будням' };
    const fact: Memory = { ...profile, id: 3, key: 'office', kind: 'semantic', content: 'Кабинет 712' };
    const messages = [
      { id: 1, role: 'assistant' as const, author: 'Мэй Мэй', content: 'Посылка — завтра.', messageId: 10,
        replyToMessageId: null, createdAt: '2026-09-09 12:00:00.000' },
      { id: 2, role: 'assistant' as const, author: 'Мэй Мэй', content: 'Стоматолог — в пятницу.', messageId: 20,
        replyToMessageId: null, createdAt: '2026-09-10T12:00:00.000Z' },
      { id: 3, role: 'user' as const, author: 'Иван', content: 'Это уже сделал.', messageId: 30,
        replyToMessageId: 10, createdAt: '2026-09-10T13:00:00.000Z' },
    ];
    const threads = {
      ensure: async () => ({ id: 1, summary: null, summaryCursor: 0, summaryVersion: 0 }),
      read: async () => messages,
    } as unknown as ThreadMemory;
    const store = {
      get: async () => profile,
      search: async (_namespace, input) => input.kind === 'procedural'
        ? { memories: [profile, rule], nextBeforeId: 2 }
        : { memories: [rule, profile, fact], nextBeforeId: 3 },
    } satisfies Pick<MemoryStore, 'get' | 'search'>;
    const result = await new MemoryContextBuilder(threads, store as unknown as MemoryStore, 50)
      .build({ id: 1, type: 'personal', userId: 1 }, 'кабинет');
    const loaded = [result.memory.profile, ...result.memory.rules.memories, ...result.memory.relevant.memories];
    expect(loaded).toEqual([profile, rule, fact]);
    expect(result.memory.rules.nextBeforeId).toBe(2);
    expect(result.memory.relevant.nextBeforeId).toBe(3);
    const history = result.history.map((message) => JSON.parse(message.content) as Record<string, unknown>);
    const reply = history.at(-1);
    expect(reply).toMatchObject({ author: 'Иван', text: 'Это уже сделал.', sent_at: '2026-09-10T13:00:00.000Z' });
    expect(history.find((message) => message.message_id === reply?.reply_to_message_id))
      .toMatchObject({ text: 'Посылка — завтра.', sent_at: '2026-09-09T12:00:00.000Z' });
  });
});
