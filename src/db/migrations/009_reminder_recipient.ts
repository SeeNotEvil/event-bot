import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // NULL keeps the author as recipient, including all existing tasks.
  await sql`alter table events
    add column reminder_recipient_user_id bigint unsigned null,
    add column recipient_version int unsigned not null default 1,
    add constraint events_recipient_fk foreign key (reminder_recipient_user_id)
      references users(id) on delete set null
  `.execute(database);
}

export function down(): Promise<void> {
  throw new Error('009_reminder_recipient requires a forward migration to preserve recipients');
}
