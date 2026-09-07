import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`create table notes (
    id bigint unsigned not null auto_increment primary key,
    chat_id bigint unsigned not null,
    created_by_user_id bigint unsigned not null,
    title varchar(255) not null,
    content mediumtext not null,
    tags json not null,
    version int unsigned not null default 1,
    created_at datetime(3) not null default current_timestamp(3),
    updated_at datetime(3) not null default current_timestamp(3),
    constraint notes_chat_fk foreign key (chat_id) references chats(id) on delete cascade,
    constraint notes_creator_fk foreign key (created_by_user_id) references users(id) on delete cascade,
    constraint notes_tags_check check (json_type(tags) = 'ARRAY'),
    key notes_chat_page_idx (chat_id, id)
  )`.execute(database);
}

export function down(): Promise<void> {
  throw new Error('011_notes requires a forward migration to preserve notes');
}
