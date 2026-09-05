import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .createTable('user_preferences')
    .addColumn('user_id', 'bigint', (column) =>
      column.unsigned().primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('content', 'text', (column) => column.notNull())
    .addColumn('created_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addColumn('updated_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable('user_preferences').ifExists().execute();
}
