import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      modify telegram_chat_id bigint null
  `.execute(database);

  await sql`
    create table calendars (
      id bigint unsigned not null auto_increment primary key,
      type varchar(16) not null,
      user_id bigint unsigned null,
      telegram_chat_id bigint null,
      title varchar(255) null,
      timezone varchar(64) not null,
      created_at datetime(3) not null default current_timestamp(3),
      updated_at datetime(3) not null default current_timestamp(3),
      constraint calendars_user_fk
        foreign key (user_id) references users(id) on delete cascade,
      constraint calendars_type_check
        check (type in ('personal', 'group')),
      constraint calendars_owner_check
        check (
          (type = 'personal' and user_id is not null and telegram_chat_id is null)
          or
          (type = 'group' and user_id is null and telegram_chat_id is not null)
        ),
      unique key calendars_user_unique (user_id),
      unique key calendars_telegram_chat_unique (telegram_chat_id)
    )
  `.execute(database);

  await sql`
    insert into calendars (type, user_id, telegram_chat_id, title, timezone)
    select 'personal', id, null, null, timezone
    from users
  `.execute(database);

  await sql`
    alter table events
      add column calendar_id bigint unsigned null after user_id
  `.execute(database);

  await sql`
    update events
    inner join calendars
      on calendars.type = 'personal'
      and calendars.user_id = events.user_id
    set events.calendar_id = calendars.id
  `.execute(database);

  await sql`
    alter table events
      add constraint events_calendar_fk
        foreign key (calendar_id) references calendars(id) on delete cascade,
      add index events_calendar_status_date_idx (calendar_id, status, date_from)
  `.execute(database);

  await sql`
    alter table conversation_messages
      add column calendar_id bigint unsigned null after user_id
  `.execute(database);

  await sql`
    update conversation_messages
    inner join calendars
      on calendars.type = 'personal'
      and calendars.user_id = conversation_messages.user_id
    set conversation_messages.calendar_id = calendars.id
  `.execute(database);

  await sql`
    alter table conversation_messages
      add constraint conversation_calendar_fk
        foreign key (calendar_id) references calendars(id) on delete cascade,
      add index conversation_calendar_created_idx (calendar_id, created_at, id)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table conversation_messages
      drop foreign key conversation_calendar_fk,
      drop index conversation_calendar_created_idx,
      drop column calendar_id
  `.execute(database);

  await sql`
    alter table events
      drop foreign key events_calendar_fk,
      drop index events_calendar_status_date_idx,
      drop column calendar_id
  `.execute(database);

  await database.schema.dropTable('calendars').ifExists().execute();

  await sql`
    update users
    set telegram_chat_id = telegram_user_id
    where telegram_chat_id is null
  `.execute(database);

  await sql`
    alter table users
      modify telegram_chat_id bigint not null
  `.execute(database);
}
