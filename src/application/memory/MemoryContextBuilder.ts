import type { Chat } from '../../types/domain.js';
import type { Memory, MemoryNamespace, MemoryPage, MemoryStore } from './MemoryStore.js';
import type { ThreadMemory } from './ThreadMemory.js';

export type MemoryContext = {
  namespace: MemoryNamespace;
  profile: Memory | null;
  rules: MemoryPage;
  relevant: MemoryPage;
  summary: string | null;
  summaryCursor: number;
};

export class MemoryContextBuilder {
  public constructor(private readonly threads: ThreadMemory, private readonly memories: MemoryStore, private readonly recentLimit: number) {}

  public async build(chat: Pick<Chat, 'id' | 'type' | 'userId'>, query: string, excludeMessageId?: number) {
    if (chat.type === 'personal' && chat.userId === null) throw new Error('A personal chat requires an owner');
    const namespace: MemoryNamespace = chat.type === 'personal'
      ? { kind: 'user', id: chat.userId! } : { kind: 'chat', id: chat.id };
    const thread = await this.threads.ensure(chat.id);
    const [messages, profile, rules, relevant] = await Promise.all([
      this.threads.read(thread.id, this.recentLimit, undefined, excludeMessageId),
      this.memories.get(namespace, 'profile'),
      this.memories.search(namespace, { query: null, kind: 'procedural', beforeId: null }),
      this.memories.search(namespace, { query, kind: null, beforeId: null }),
    ]);
    const memory: MemoryContext = { namespace, profile, rules, relevant, summary: thread.summary, summaryCursor: thread.summaryCursor };
    return { threadId: thread.id, memory, history: messages.map((row) => ({
      role: row.role, content: row.role === 'user' && row.author ? `${row.author}: ${row.content}` : row.content,
    })) };
  }
}
