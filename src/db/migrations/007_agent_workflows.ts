import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`alter table events
    drop check events_date_range_check,
    modify date_from date null,
    add column deadline_version int unsigned not null default 1,
    add column reminder_mode varchar(16) not null default 'legacy',
    add column check_completion boolean not null default false,
    add constraint events_date_range_check check (
      (date_from is null and date_to is null and time is null)
      or (date_from is not null and (date_to is null or date_to >= date_from))
    ),
    add constraint events_reminder_mode_check check (reminder_mode in ('legacy','default','custom','off'))
  `.execute(database);
  await sql`alter table notifications
    drop index notifications_event_remind_unique,
    add column kind varchar(32) not null default 'reminder',
    add column source varchar(16) not null default 'manual',
    add column deadline_version int unsigned not null default 1,
    add column telegram_message_id bigint null,
    add column answer boolean null,
    add column action_applied boolean not null default false,
    add column answered_at datetime(3) null,
    add column retry_at datetime(3) null,
    add unique key notifications_event_kind_time_unique (event_id, deadline_version, kind, remind_at_utc),
    add constraint notifications_kind_check check (kind in ('reminder','completion_check','readiness_response'))
  `.execute(database);
  await sql`alter table conversation_messages
    modify user_id bigint unsigned null,
    add column telegram_message_id bigint null,
    add column reply_to_message_id bigint null,
    add column author_name varchar(255) null,
    add unique key conversation_telegram_message_unique (calendar_id, telegram_message_id)
  `.execute(database);
  await sql`create table calendar_lists (
    calendar_id bigint unsigned not null primary key,
    revision bigint unsigned not null default 1,
    published_revision bigint unsigned not null default 0,
    page int unsigned not null default 1,
    published_page int unsigned not null default 0,
    message_id bigint null,
    lock_token varchar(36) null,
    locked_at datetime(3) null,
    retry_at datetime(3) null,
    last_error text null,
    constraint calendar_lists_calendar_fk foreign key (calendar_id) references calendars(id) on delete cascade
  )`.execute(database);
}

// Undated tasks cannot be represented by the old schema. Roll forward instead
// of assigning invented dates or deleting user data during a rollback.
export function down(): Promise<void> {
  throw new Error('007_agent_workflows requires a forward migration to preserve undated tasks');
}
