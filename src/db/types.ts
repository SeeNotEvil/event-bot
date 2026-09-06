import type { ColumnType, Generated } from 'kysely';

type CreatedTimestamp = Generated<string>;
type UpdatedTimestamp = ColumnType<string, string | Date | undefined, string | Date>;
type DateTimeColumn = ColumnType<string, string | Date, string | Date>;
type ChatIdColumn = ColumnType<number | null, number, number | null>;
type NullableDateTimeColumn = ColumnType<
  string | null,
  string | Date | null | undefined,
  string | Date | null
>;

export interface UsersTable {
  id: Generated<number>;
  telegram_user_id: number;
  telegram_chat_id: number | null;
  telegram_username: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface ChatsTable {
  id: Generated<number>;
  type: 'personal' | 'group';
  user_id: number | null;
  telegram_chat_id: number | null;
  title: string | null;
  timezone: string;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface EventsTable {
  id: Generated<number>;
  user_id: number;
  chat_id: ChatIdColumn;
  title: string;
  description: string | null;
  date_from: string | null;
  date_to: string | null;
  time: string | null;
  status: 'active' | 'completed' | 'deleted';
  completed_at: NullableDateTimeColumn;
  deadline_version: Generated<number>;
  reminder_mode: Generated<'legacy' | 'default' | 'custom' | 'off'>;
  check_completion: Generated<number>;
  reminder_recipient_user_id: Generated<number | null>;
  recipient_version: Generated<number>;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface ConversationMessagesTable {
  id: Generated<number>;
  user_id: number | null;
  thread_id: ChatIdColumn;
  role: 'user' | 'assistant';
  content: string;
  telegram_message_id: Generated<number | null>;
  reply_to_message_id: Generated<number | null>;
  author_name: Generated<string | null>;
  created_at: CreatedTimestamp;
}

export interface MemoriesTable {
  id: Generated<number>;
  namespace: 'user' | 'chat';
  user_id: number | null;
  chat_id: number | null;
  memory_key: string;
  kind: 'semantic' | 'episodic' | 'procedural';
  content: string;
  source_message_id: number | null;
  source: string;
  version: Generated<number>;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface ThreadsTable {
  id: Generated<number>;
  chat_id: number;
  summary: Generated<string | null>;
  summary_cursor: Generated<number>;
  summary_version: Generated<number>;
  lock_token: Generated<string | null>;
  locked_at: NullableDateTimeColumn;
  retry_at: NullableDateTimeColumn;
  last_error: Generated<string | null>;
  updated_at: UpdatedTimestamp;
}

export interface NotificationsTable {
  id: Generated<number>;
  event_id: number;
  remind_at_utc: DateTimeColumn;
  timezone: string;
  status: 'pending' | 'sent' | 'cancelled';
  attempts: Generated<number>;
  lock_token: string | null;
  locked_at: NullableDateTimeColumn;
  sent_at: NullableDateTimeColumn;
  last_error: string | null;
  kind: Generated<'reminder' | 'completion_check' | 'readiness_response'>;
  source: Generated<'manual' | 'automatic'>;
  deadline_version: Generated<number>;
  telegram_message_id: Generated<number | null>;
  answer: Generated<number | null>;
  action_applied: Generated<number>;
  answered_at: NullableDateTimeColumn;
  retry_at: NullableDateTimeColumn;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface Database {
  users: UsersTable;
  chats: ChatsTable;
  events: EventsTable;
  conversation_messages: ConversationMessagesTable;
  threads: ThreadsTable;
  memories: MemoriesTable;
  notifications: NotificationsTable;
}
