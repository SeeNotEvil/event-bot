import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table events
      add column completed_at datetime(3) null after status,
      drop check events_status_check,
      add constraint events_status_check
        check (status in ('active', 'completed', 'deleted')),
      add constraint events_completion_check
        check (
          (status = 'active' and completed_at is null)
          or (status = 'completed' and completed_at is not null)
          or status = 'deleted'
        )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    update events
    set status = 'active', completed_at = null, updated_at = current_timestamp(3)
    where status = 'completed'
  `.execute(database);

  await sql`
    alter table events
      drop check events_completion_check,
      drop check events_status_check,
      drop column completed_at,
      add constraint events_status_check check (status in ('active', 'deleted'))
  `.execute(database);
}
