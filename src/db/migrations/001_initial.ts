import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .createTable('users')
    .addColumn('id', 'bigint', (column) => column.unsigned().autoIncrement().primaryKey())
    .addColumn('telegram_user_id', 'bigint', (column) => column.notNull().unique())
    .addColumn('telegram_chat_id', 'bigint', (column) => column.notNull())
    .addColumn('timezone', 'varchar(64)', (column) => column.notNull())
    .addColumn('created_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addColumn('updated_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .execute();

  await database.schema
    .createTable('events')
    .addColumn('id', 'bigint', (column) => column.unsigned().autoIncrement().primaryKey())
    .addColumn('user_id', 'bigint', (column) =>
      column.unsigned().notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('title', 'varchar(255)', (column) => column.notNull())
    .addColumn('description', 'text')
    .addColumn('date_from', 'date', (column) => column.notNull())
    .addColumn('date_to', 'date')
    .addColumn('time', 'time')
    .addColumn('status', 'varchar(16)', (column) => column.notNull())
    .addColumn('created_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addColumn('updated_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addCheckConstraint('events_status_check', sql`status in ('active', 'deleted')`)
    .addCheckConstraint('events_date_range_check', sql`date_to is null or date_to >= date_from`)
    .execute();

  await database.schema
    .createIndex('events_user_status_date_idx')
    .on('events')
    .columns(['user_id', 'status', 'date_from'])
    .execute();

  await database.schema
    .createTable('conversation_messages')
    .addColumn('id', 'bigint', (column) => column.unsigned().autoIncrement().primaryKey())
    .addColumn('user_id', 'bigint', (column) =>
      column.unsigned().notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('role', 'varchar(16)', (column) => column.notNull())
    .addColumn('content', 'text', (column) => column.notNull())
    .addColumn('created_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addCheckConstraint('conversation_role_check', sql`role in ('user', 'assistant')`)
    .execute();

  await database.schema
    .createIndex('conversation_user_created_idx')
    .on('conversation_messages')
    .columns(['user_id', 'created_at', 'id'])
    .execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable('conversation_messages').ifExists().execute();
  await database.schema.dropTable('events').ifExists().execute();
  await database.schema.dropTable('users').ifExists().execute();
}
