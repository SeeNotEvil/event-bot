import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  // Renaming preserves IDs, event/notification relationships and published lists.
  await sql`rename table calendars to chats, calendar_lists to chat_lists`.execute(database);
  // MySQL may require COPY for tables with CHECK constraints; drop and restore
  // these foreign keys explicitly so renaming their columns also works there.
  await sql`alter table events drop foreign key events_calendar_fk`.execute(database);
  await sql`alter table events rename column calendar_id to chat_id,
    rename index events_calendar_status_date_idx to events_chat_status_date_idx`.execute(database);
  await sql`alter table events add constraint events_chat_fk
    foreign key (chat_id) references chats(id) on delete cascade`.execute(database);
  await sql`alter table chat_lists drop foreign key calendar_lists_calendar_fk`.execute(database);
  await sql`alter table chat_lists rename column calendar_id to chat_id`.execute(database);
  await sql`alter table chat_lists add constraint chat_lists_chat_fk
    foreign key (chat_id) references chats(id) on delete cascade`.execute(database);
  await sql`create table threads (
    id bigint unsigned not null auto_increment primary key,
    chat_id bigint unsigned not null,
    summary text null,
    summary_cursor bigint unsigned not null default 0,
    summary_version bigint unsigned not null default 0,
    lock_token varchar(36) null,
    locked_at datetime(3) null,
    retry_at datetime(3) null,
    last_error text null,
    updated_at datetime(3) not null default current_timestamp(3),
    unique key threads_chat_unique (chat_id),
    constraint threads_chat_fk foreign key (chat_id) references chats(id) on delete cascade
  )`.execute(database);
  await sql`insert into threads (id, chat_id) select id, id from chats`.execute(database);
  await sql`alter table conversation_messages drop foreign key conversation_calendar_fk`.execute(database);
  await sql`alter table conversation_messages
    rename column calendar_id to thread_id,
    rename index conversation_calendar_created_idx to conversation_thread_created_idx,
    add index conversation_thread_id_idx (thread_id, id)
  `.execute(database);
  await sql`alter table conversation_messages
    add constraint conversation_thread_fk foreign key (thread_id) references threads(id) on delete cascade
  `.execute(database);
  await sql`create table memories (
    id bigint unsigned not null auto_increment primary key,
    namespace varchar(8) not null,
    user_id bigint unsigned null,
    chat_id bigint unsigned null,
    memory_key varchar(191) not null,
    kind varchar(16) not null,
    content text not null,
    source_message_id bigint unsigned null,
    source varchar(32) not null,
    version bigint unsigned not null default 1,
    created_at datetime(3) not null default current_timestamp(3),
    updated_at datetime(3) not null default current_timestamp(3),
    unique key memories_user_key (user_id, memory_key),
    unique key memories_chat_key (chat_id, memory_key),
    constraint memories_user_fk foreign key (user_id) references users(id) on delete cascade,
    constraint memories_chat_fk foreign key (chat_id) references chats(id) on delete cascade,
    constraint memories_source_fk foreign key (source_message_id) references conversation_messages(id) on delete set null,
    constraint memories_namespace_check check (
      (namespace = 'user' and user_id is not null and chat_id is null)
      or (namespace = 'chat' and chat_id is not null and user_id is null)
    ),
    constraint memories_kind_check check (kind in ('semantic', 'episodic', 'procedural'))
  )`.execute(database);
  await sql`insert into memories (namespace, user_id, memory_key, kind, content, source, created_at, updated_at)
    select 'user', user_id, 'profile', 'procedural', content, 'preferences_migration', created_at, updated_at
    from user_preferences`.execute(database);
  await sql`drop table user_preferences`.execute(database);
}

export function down(): Promise<void> {
  throw new Error('008_thread_memory requires a forward migration to preserve memories and history');
}
