import { z } from 'zod';
import type { AgentContext } from '../../types/domain.js';
import { memoryKindSchema, memoryPageSchema, memoryResultSchema, memoryWriteSchema, type MemoryStore } from '../../application/memory/MemoryStore.js';
import { defineTool } from './Tool.js';

function namespace(context: AgentContext) {
  if (!context.memory) throw new Error('Memory context is missing');
  return context.memory.namespace;
}

export function canWriteMemory(context: AgentContext) {
  return context.userId !== null && context.sourceMessageId !== undefined
    && context.trigger?.kind !== 'notification'
    && context.trigger?.kind !== 'service';
}

export function createSearchMemoryTool(store: MemoryStore) {
  return defineTool({
    name: 'search_memory', description: 'Ищет долгосрочные воспоминания только в доступной памяти: личной в личке, общей в текущей группе. Текстовый поиск по словам ключа/содержимого; при необходимости переформулируй запрос. query=null читает все записи. До 10 результатов, nextBeforeId передай как beforeId для следующей страницы. Версии нужны для изменения и удаления. Пустая страница не доказывает, что факт никогда не обсуждался: есть архив read_chat_messages.',
    input: z.object({ query: z.string().max(1_000).nullable(), kind: memoryKindSchema.nullable(), beforeId: z.number().int().positive().safe().nullable() }),
    output: memoryPageSchema,
    execute: (context, input) => store.search(namespace(context), input),
  });
}

export function createSaveMemoryTool(store: MemoryStore) {
  return defineTool({
    name: 'save_memory', requiresUser: true, availableWhen: canWriteMemory,
    description: 'Создаёт или обновляет устойчивый факт (semantic), полезный прошлый опыт (episodic) либо пожелание/правило чата (procedural) из текущего обращения к тебе. Область и источник задаёт сервер. Одна запись — один понятный факт с устойчивым ключом. Сначала найди существующую запись; для новой expectedVersion=null, для изменения — прочитанная версия. При конфликте перечитай и учти свежие сведения. Не сохраняй догадки, секреты, текущие статусы задач или факты из окружающей переписки без обращения. Ключ profile зарезервирован для цельной памятки предпочтений.',
    input: memoryWriteSchema, output: memoryResultSchema,
    execute: async (context, input) => {
      if (!canWriteMemory(context)) throw new Error('An addressed message is required');
      const result = await store.save(namespace(context), input, { messageId: context.sourceMessageId!, label: 'addressed_message' });
      if (result.success && input.key === 'profile' && context.memory) {
        context.memory.profile = result.memory;
        if (context.chatType === 'personal') context.userPreferences = result.memory?.content ?? null;
      }
      return result;
    },
  });
}

export function createForgetMemoryTool(store: MemoryStore) {
  return defineTool({
    name: 'forget_memory', requiresUser: true, availableWhen: canWriteMemory,
    description: 'Удаляет выбранное долгосрочное воспоминание по ID и прочитанной версии только в текущей области. Используй по просьбе забыть факт. При конфликте перечитай запись. Удаление воспоминания не удаляет исходную переписку или сводку; не обещай удалить их этим инструментом.',
    input: z.object({ id: z.number().int().positive().safe(), expectedVersion: z.number().int().positive() }),
    output: memoryResultSchema,
    execute: async (context, input) => {
      if (!canWriteMemory(context)) throw new Error('An addressed message is required');
      const result = await store.forget(namespace(context), input.id, input.expectedVersion);
      if (result.success && context.memory) {
        if (context.memory.profile?.id === input.id) { context.memory.profile = null; context.userPreferences = null; }
        context.memory.rules.memories = context.memory.rules.memories.filter((memory) => memory.id !== input.id);
        context.memory.relevant.memories = context.memory.relevant.memories.filter((memory) => memory.id !== input.id);
      }
      return result;
    },
  });
}
