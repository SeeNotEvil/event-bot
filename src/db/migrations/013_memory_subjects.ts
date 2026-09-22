import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // MySQL DDL commits independently of the migration record. Keep retries safe.
  const existing = await sql<{ count: number }>`select count(*) as count from information_schema.columns
    where table_schema = database() and table_name = 'memories' and column_name = 'subject_user_id'`.execute(database);
  if (Number(existing.rows[0]?.count) === 0) {
    await sql`alter table memories
      add column subject_user_id bigint unsigned null,
      add column subject_scope_id bigint unsigned not null default 0,
      add constraint memories_subject_user_fk foreign key (subject_user_id) references users(id) on delete cascade,
      drop index memories_user_key,
      drop index memories_chat_key,
      add unique key memories_user_key (user_id, subject_scope_id, memory_key),
      add unique key memories_chat_key (chat_id, subject_scope_id, memory_key),
      add index memories_subject_page_idx (namespace, chat_id, subject_user_id, kind, id)
    `.execute(database);
  }
  // The source of a group memory is not necessarily its subject. Do not guess.
  // The store writes subject_scope_id together with subject_user_id. Zero makes
  // shared keys unique despite MySQL allowing repeated NULLs in unique indexes.
  // Keep this a regular column: generated base columns cannot use FK CASCADE.
  await sql`update memories set subject_user_id = user_id, subject_scope_id = user_id
    where namespace = 'user' and subject_user_id is null`.execute(database);
}

export function down(): Promise<void> {
  throw new Error('013_memory_subjects requires a forward migration to preserve per-person memories');
}
