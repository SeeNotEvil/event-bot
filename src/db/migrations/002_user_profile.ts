import type { Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .alterTable('users')
    .addColumn('telegram_username', 'varchar(255)')
    .addColumn('first_name', 'varchar(255)')
    .addColumn('last_name', 'varchar(255)')
    .execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .alterTable('users')
    .dropColumn('last_name')
    .dropColumn('first_name')
    .dropColumn('telegram_username')
    .execute();
}
