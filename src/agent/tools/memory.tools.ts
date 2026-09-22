import { z } from 'zod';
import type { AgentContext } from '../../types/domain.js';
import { memoryKindSchema, memoryPageSchema, memoryResultSchema, memoryWriteSchema, type MemoryStore } from '../../application/memory/MemoryStore.js';
import { defineTool } from './Tool.js';

function namespace(context: AgentContext) {
  if (!context.memory) throw new Error('Memory context is missing');
  return context.memory.namespace;
}

export function canWriteMemory(context: AgentContext) {
  return context.userId !== null && (context.sourceMessageId !== undefined
    || context.trigger?.kind === 'agent_task' || context.trigger?.kind === 'notification')
    && context.trigger?.kind !== 'service';
}

export function memorySource(context: AgentContext) {
  return { messageId: context.sourceMessageId ?? null, userId: context.userId,
    label: context.sourceMessageId === undefined ? 'scheduled_task' : 'addressed_message' };
}

export function createSearchMemoryTool(store: MemoryStore) {
  return defineTool({
    name: 'search_memory', description: 'Ищет долгосрочные воспоминания только в доступной памяти: личной в личке, общей в текущей группе. subjectUserId — внутренний ID человека (например actor.id), для него вернутся персональные и общие записи; null — все участники текущей области. Это не Telegram ID. Текстовый поиск по словам ключа/содержимого; при необходимости переформулируй запрос. query=null читает записи без текстового фильтра. До 10 результатов, nextBeforeId передай как beforeId для следующей страницы. Версии нужны для изменения и удаления. Пустая страница не доказывает, что факт никогда не обсуждался: есть архив read_chat_messages.',
    input: z.object({ query: z.string().max(1_000).nullable(), kind: memoryKindSchema.nullable(),
      subjectUserId: z.number().int().positive().safe().nullable(), beforeId: z.number().int().positive().safe().nullable() }),
    output: memoryPageSchema,
    execute: (context, input) => store.search(namespace(context), { query: input.query, kind: input.kind, beforeId: input.beforeId,
      ...(input.subjectUserId === null ? {} : { subjectUserId: input.subjectUserId, includeShared: true }) }),
  });
}

export function createSaveMemoryTool(store: MemoryStore) {
  return defineTool({
    name: 'save_memory', requiresUser: true, availableWhen: canWriteMemory,
    description: 'Создаёт или обновляет устойчивый факт (semantic), полезный прошлый опыт (episodic) либо пожелание/правило (procedural) из текущего обращения к тебе. Область и источник задаёт сервер. subjectUserId — внутренний ID человека, к которому относится запись: для пожеланий собеседника actor.id; null — явно общее правило группы. ID другого участника бери только из прочитанных данных этого чата; сервер проверяет, что человек известен в этой области. В личке запись относится владельцу. Одна запись — один понятный факт с устойчивым ключом; один ключ может отдельно существовать у разных людей. Сначала найди запись того же человека; для новой expectedVersion=null, для изменения — прочитанная версия и прежний subjectUserId. При конфликте перечитай. Сохраняй неизвестные детали как неуточнённые. Не сохраняй догадки, секреты, текущие статусы задач, разовые просьбы пошутить или факты из окружающей переписки без обращения. Ключ profile зарезервирован для цельной памятки предпочтений.',
    input: memoryWriteSchema, output: memoryResultSchema,
    execute: async (context, input) => {
      if (!canWriteMemory(context)) throw new Error('A task owner and source context are required');
      const result = await store.save(namespace(context), input, memorySource(context));
      if (result.success && result.memory && context.memory) {
        const saved = result.memory;
        context.memory.rules.memories = context.memory.rules.memories.filter((memory) => memory.id !== saved.id);
        context.memory.relevant.memories = context.memory.relevant.memories.filter((memory) => memory.id !== saved.id);
        if (input.key === 'profile' && (saved.subjectUserId === null || context.chatType === 'personal')) {
          context.memory.profile = saved;
          if (context.chatType === 'personal') context.userPreferences = saved.content;
        } else if (saved.kind === 'procedural' && (saved.subjectUserId === null || saved.subjectUserId === context.userId)) {
          context.memory.rules.memories.push(saved);
        } else {
          context.memory.relevant.memories.push(saved);
        }
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
      if (!canWriteMemory(context)) throw new Error('A task owner and source context are required');
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
