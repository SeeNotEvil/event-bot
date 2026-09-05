import type { ColumnType, Generated } from 'kysely';

type CreatedTimestamp = Generated<string>;
type UpdatedTimestamp = ColumnType<string, string | Date | undefined, string | Date>;
type DateTimeColumn = ColumnType<string, string | Date, string | Date>;
type CalendarIdColumn = ColumnType<number | null, number, number | null>;
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

export interface CalendarsTable {
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
  calendar_id: CalendarIdColumn;
  title: string;
  description: string | null;
  date_from: string;
  date_to: string | null;
  time: string | null;
  status: 'active' | 'completed' | 'deleted';
  completed_at: NullableDateTimeColumn;
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface ConversationMessagesTable {
  id: Generated<number>;
  user_id: number;
  calendar_id: CalendarIdColumn;
  role: 'user' | 'assistant';
  content: string;
  created_at: CreatedTimestamp;
}

export interface UserPreferencesTable {
  user_id: number;
  content: string;
  created_at: CreatedTimestamp;
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
  created_at: CreatedTimestamp;
  updated_at: UpdatedTimestamp;
}

export interface Database {
  users: UsersTable;
  calendars: CalendarsTable;
  events: EventsTable;
  conversation_messages: ConversationMessagesTable;
  user_preferences: UserPreferencesTable;
  notifications: NotificationsTable;
}
