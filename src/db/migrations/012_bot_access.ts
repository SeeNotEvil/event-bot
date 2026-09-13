import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema.createTable('bot_access')
    .addColumn('telegram_user_id', 'bigint', (column) => column.primaryKey())
    .addColumn('added_by_telegram_user_id', 'bigint', (column) => column.notNull())
    .addColumn('created_at', 'datetime(3)', (column) => column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`))
    .execute();
  await database.schema.alterTable('threads').addColumn('summary_access_key', 'varchar(64)').execute();
  await sql`alter table memories
    add column source_user_id bigint unsigned null,
    add constraint memories_source_user_fk foreign key (source_user_id) references users(id) on delete set null
  `.execute(database);
  await sql`update memories m left join conversation_messages cm on cm.id = m.source_message_id
    set m.source_user_id = coalesce(cm.user_id, m.user_id)`.execute(database);
}

export function down(): Promise<void> {
  throw new Error('012_bot_access requires a forward migration to preserve access and memory sources');
}
