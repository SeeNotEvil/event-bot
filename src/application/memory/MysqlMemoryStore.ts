import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, MemoriesTable } from '../../db/types.js';
import { memoryWriteSchema, type MemoryNamespace, type MemorySearch, type MemorySource, type MemoryStore, type MemoryWrite } from './MemoryStore.js';

function ownerColumn(namespace: MemoryNamespace) {
  return namespace.kind === 'user' ? 'user_id' as const : 'chat_id' as const;
}

function mapMemory(row: Selectable<MemoriesTable>) {
  return { id: Number(row.id), key: row.memory_key, kind: row.kind, content: row.content,
    version: Number(row.version), source: row.source,
    sourceMessageId: row.source_message_id === null ? null : Number(row.source_message_id), updatedAt: row.updated_at };
}

export class MysqlMemoryStore implements MemoryStore {
  public constructor(private readonly database: Kysely<Database>) {}

  public async get(namespace: MemoryNamespace, key: string) {
    const row = await this.database.selectFrom('memories').selectAll().where('namespace', '=', namespace.kind)
      .where(ownerColumn(namespace), '=', namespace.id).where('memory_key', '=', key).executeTakeFirst();
    return row ? mapMemory(row) : null;
  }

  public async search(namespace: MemoryNamespace, input: MemorySearch) {
    let query = this.database.selectFrom('memories').selectAll().where('namespace', '=', namespace.kind)
      .where(ownerColumn(namespace), '=', namespace.id);
    if (input.kind) query = query.where('kind', '=', input.kind);
    if (input.beforeId !== null) query = query.where('id', '<', input.beforeId);
    const terms = [...new Set(input.query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
      .sort((a, b) => b.length - a.length).slice(0, 8);
    if (terms.length) query = query.where((eb) => eb.or(terms.flatMap((term) => {
      const pattern = `%${term.replace(/[!%_]/g, '!$&')}%`;
      return [sql<boolean>`memory_key like ${pattern} escape '!'`, sql<boolean>`content like ${pattern} escape '!'`];
    })));
    const rows = await query.orderBy('id', 'desc').limit(11).execute();
    const memories = rows.slice(0, 10).map(mapMemory);
    return { memories, nextBeforeId: rows.length > 10 ? memories.at(-1)!.id : null };
  }

  public async save(namespace: MemoryNamespace, rawInput: MemoryWrite, source: MemorySource) {
    const input = memoryWriteSchema.parse(rawInput);
    const values = { kind: input.kind, content: input.content, source_message_id: source.messageId,
      source: source.label, updated_at: new Date() };
    const result = input.expectedVersion === null
      ? await this.database.insertInto('memories').values({ ...values, namespace: namespace.kind,
        user_id: namespace.kind === 'user' ? namespace.id : null,
        chat_id: namespace.kind === 'chat' ? namespace.id : null, memory_key: input.key,
      }).onDuplicateKeyUpdate({ id: sql<number>`id` }).executeTakeFirstOrThrow()
      : await this.database.updateTable('memories').set({ ...values, version: input.expectedVersion + 1 })
        .where('namespace', '=', namespace.kind).where(ownerColumn(namespace), '=', namespace.id)
        .where('memory_key', '=', input.key).where('version', '=', input.expectedVersion).executeTakeFirstOrThrow();
    const changed = 'numUpdatedRows' in result ? Number(result.numUpdatedRows) === 1 : Number(result.insertId) > 0;
    return { success: changed, reason: changed ? null : 'VERSION_CONFLICT' as const,
      memory: await this.get(namespace, input.key) };
  }

  public async forget(namespace: MemoryNamespace, id: number, expectedVersion: number) {
    const result = await this.database.deleteFrom('memories').where('namespace', '=', namespace.kind)
      .where(ownerColumn(namespace), '=', namespace.id).where('id', '=', id).where('version', '=', expectedVersion).executeTakeFirstOrThrow();
    if (Number(result.numDeletedRows) === 1) return { success: true, reason: null, memory: null };
    const row = await this.database.selectFrom('memories').selectAll().where('namespace', '=', namespace.kind)
      .where(ownerColumn(namespace), '=', namespace.id).where('id', '=', id).executeTakeFirst();
    return { success: false, reason: row ? 'VERSION_CONFLICT' as const : 'NOT_FOUND' as const, memory: row ? mapMemory(row) : null };
  }
}
