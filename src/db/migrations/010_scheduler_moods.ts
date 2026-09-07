import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create table mood_entries (
    id bigint unsigned not null auto_increment primary key,
    user_id bigint unsigned not null,
    score tinyint unsigned not null,
    comment text null,
    occurred_at_utc datetime(3) not null,
    timezone varchar(64) not null,
    version int unsigned not null default 1,
    created_at datetime(3) not null default current_timestamp(3),
    updated_at datetime(3) not null default current_timestamp(3),
    constraint moods_user_fk foreign key (user_id) references users(id) on delete cascade,
    constraint moods_score_check check (score between 1 and 10),
    key moods_user_time_idx (user_id, occurred_at_utc, id)
  )`.execute(database);
  await sql`create table schedules (
    id bigint unsigned not null auto_increment primary key,
    created_by_user_id bigint unsigned not null,
    chat_id bigint unsigned not null,
    event_id bigint unsigned null,
    kind varchar(32) not null default 'agent_task',
    payload json not null,
    recurrence varchar(16) not null,
    local_time time not null,
    weekdays json null,
    timezone varchar(64) not null,
    next_run_at_utc datetime(3) null,
    enabled boolean not null default true,
    version int unsigned not null default 1,
    created_at datetime(3) not null default current_timestamp(3),
    updated_at datetime(3) not null default current_timestamp(3),
    constraint schedules_user_fk foreign key (created_by_user_id) references users(id) on delete cascade,
    constraint schedules_chat_fk foreign key (chat_id) references chats(id) on delete cascade,
    constraint schedules_event_fk foreign key (event_id) references events(id) on delete cascade,
    constraint schedules_kind_check check (kind = 'agent_task'),
    constraint schedules_recurrence_check check (recurrence in ('daily', 'weekly')),
    constraint schedules_cursor_check check (not enabled or next_run_at_utc is not null),
    key schedules_dispatch_idx (enabled, next_run_at_utc, id),
    key schedules_owner_idx (chat_id, created_by_user_id, id)
  )`.execute(database);
  await sql`alter table notifications
    drop check notifications_kind_check,
    drop check notifications_status_check,
    modify event_id bigint unsigned null,
    add column chat_id bigint unsigned null,
    add column created_by_user_id bigint unsigned null,
    add column schedule_id bigint unsigned null,
    add column schedule_version int unsigned null,
    add column payload json null,
    add column version int unsigned not null default 1,
    drop index notifications_event_kind_time_unique,
    add column legacy_kind varchar(32) generated always as (case when kind = 'agent_task' then null else kind end) stored,
    add unique key notifications_event_kind_time_unique (event_id, deadline_version, legacy_kind, remind_at_utc),
    add constraint notifications_kind_check check (kind in ('reminder','completion_check','readiness_response','agent_task')),
    add constraint notifications_status_check check (status in ('pending','sent','cancelled','skipped'))
  `.execute(database);
  await sql`update notifications n join events e on e.id = n.event_id
    set n.chat_id = e.chat_id, n.created_by_user_id = e.user_id`.execute(database);
  await sql`alter table notifications
    modify chat_id bigint unsigned not null,
    modify created_by_user_id bigint unsigned not null,
    add constraint notifications_chat_fk foreign key (chat_id) references chats(id) on delete cascade,
    add constraint notifications_creator_fk foreign key (created_by_user_id) references users(id) on delete cascade,
    add constraint notifications_schedule_fk foreign key (schedule_id) references schedules(id) on delete cascade,
    add constraint notifications_target_check check (
      (kind = 'agent_task' and payload is not null) or (kind <> 'agent_task' and event_id is not null)
    ),
    add constraint notifications_schedule_version_check check (
      (schedule_id is null and schedule_version is null) or (schedule_id is not null and schedule_version is not null)
    ),
    add unique key notifications_occurrence_unique (schedule_id, schedule_version, remind_at_utc),
    add key notifications_chat_owner_idx (chat_id, created_by_user_id, status, remind_at_utc)
  `.execute(database);
}

export function down(): Promise<void> {
  throw new Error('010_scheduler_moods requires a forward migration to preserve scheduled tasks and moods');
}
