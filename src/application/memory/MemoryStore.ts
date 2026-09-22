import { z } from 'zod';

export type MemoryNamespace = { kind: 'user' | 'chat'; id: number };
export const memoryKindSchema = z.enum(['semantic', 'episodic', 'procedural']);
export const memorySchema = z.object({
  id: z.number(), key: z.string(), kind: memoryKindSchema, content: z.string(), version: z.number(),
  source: z.string(), sourceMessageId: z.number().nullable(), subjectUserId: z.number().nullable(), updatedAt: z.string(),
});
export type Memory = z.infer<typeof memorySchema>;
export type MemorySearch = { query: string | null; kind: Memory['kind'] | null; beforeId: number | null;
  subjectUserId?: number | null; includeShared?: boolean };
export const memoryPageSchema = z.object({ memories: z.array(memorySchema), nextBeforeId: z.number().nullable() });
export type MemoryPage = z.infer<typeof memoryPageSchema>;
export const memoryWriteSchema = z.object({
  key: z.string().trim().min(1).max(191), kind: memoryKindSchema,
  content: z.string().trim().min(1).max(4_000), expectedVersion: z.number().int().positive().nullable(),
  subjectUserId: z.number().int().positive().safe().nullable(),
});
export type MemoryWrite = Omit<z.infer<typeof memoryWriteSchema>, 'subjectUserId'> & { subjectUserId?: number | null };
export type MemorySource = { messageId: number | null; label: string; userId?: number | null };
export const memoryResultSchema = z.object({
  success: z.boolean(), reason: z.enum(['VERSION_CONFLICT', 'NOT_FOUND', 'INVALID_SUBJECT']).nullable(), memory: memorySchema.nullable(),
});
export type MemoryResult = z.infer<typeof memoryResultSchema>;

export interface MemoryStore {
  get(namespace: MemoryNamespace, key: string, subjectUserId?: number | null): Promise<Memory | null>;
  search(namespace: MemoryNamespace, input: MemorySearch): Promise<MemoryPage>;
  save(namespace: MemoryNamespace, input: MemoryWrite, source: MemorySource): Promise<MemoryResult>;
  forget(namespace: MemoryNamespace, id: number, expectedVersion: number): Promise<MemoryResult>;
}
