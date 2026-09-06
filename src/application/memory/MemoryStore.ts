import { z } from 'zod';

export type MemoryNamespace = { kind: 'user' | 'chat'; id: number };
export const memoryKindSchema = z.enum(['semantic', 'episodic', 'procedural']);
export const memorySchema = z.object({
  id: z.number(), key: z.string(), kind: memoryKindSchema, content: z.string(), version: z.number(),
  source: z.string(), sourceMessageId: z.number().nullable(), updatedAt: z.string(),
});
export type Memory = z.infer<typeof memorySchema>;
export type MemorySearch = { query: string | null; kind: Memory['kind'] | null; beforeId: number | null };
export const memoryPageSchema = z.object({ memories: z.array(memorySchema), nextBeforeId: z.number().nullable() });
export type MemoryPage = z.infer<typeof memoryPageSchema>;
export const memoryWriteSchema = z.object({
  key: z.string().trim().min(1).max(191), kind: memoryKindSchema,
  content: z.string().trim().min(1).max(4_000), expectedVersion: z.number().int().positive().nullable(),
});
export type MemoryWrite = z.infer<typeof memoryWriteSchema>;
export type MemorySource = { messageId: number | null; label: string };
export const memoryResultSchema = z.object({
  success: z.boolean(), reason: z.enum(['VERSION_CONFLICT', 'NOT_FOUND']).nullable(), memory: memorySchema.nullable(),
});
export type MemoryResult = z.infer<typeof memoryResultSchema>;

export interface MemoryStore {
  get(namespace: MemoryNamespace, key: string): Promise<Memory | null>;
  search(namespace: MemoryNamespace, input: MemorySearch): Promise<MemoryPage>;
  save(namespace: MemoryNamespace, input: MemoryWrite, source: MemorySource): Promise<MemoryResult>;
  forget(namespace: MemoryNamespace, id: number, expectedVersion: number): Promise<MemoryResult>;
}
