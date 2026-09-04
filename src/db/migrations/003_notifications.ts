import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .createTable('notifications')
    .addColumn('id', 'bigint', (column) => column.unsigned().autoIncrement().primaryKey())
    .addColumn('event_id', 'bigint', (column) =>
      column.unsigned().notNull().references('events.id').onDelete('cascade'),
    )
    .addColumn('remind_at_utc', 'datetime(3)', (column) => column.notNull())
    .addColumn('timezone', 'varchar(64)', (column) => column.notNull())
    .addColumn('status', 'varchar(16)', (column) =>
      column.notNull().defaultTo('pending'),
    )
    .addColumn('attempts', 'integer', (column) =>
      column.unsigned().notNull().defaultTo(0),
    )
    .addColumn('lock_token', 'varchar(36)')
    .addColumn('locked_at', 'datetime(3)')
    .addColumn('sent_at', 'datetime(3)')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addColumn('updated_at', 'datetime(3)', (column) =>
      column.notNull().defaultTo(sql`CURRENT_TIMESTAMP(3)`),
    )
    .addCheckConstraint(
      'notifications_status_check',
      sql`status in ('pending', 'sent', 'cancelled')`,
    )
    .execute();

  await database.schema
    .createIndex('notifications_event_remind_unique')
    .unique()
    .on('notifications')
    .columns(['event_id', 'remind_at_utc'])
    .execute();

  await database.schema
    .createIndex('notifications_dispatch_idx')
    .on('notifications')
    .columns(['status', 'remind_at_utc', 'locked_at'])
    .execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable('notifications').ifExists().execute();
}
