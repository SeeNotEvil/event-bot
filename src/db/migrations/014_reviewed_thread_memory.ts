import { sql, type Kysely } from 'kysely';
import type { Database } from '../types.js';

// Fixed texts prepared from the summary and conversation provided by the owner.
const records = [
  {
    key: 'task_terminology',
    content: 'По договорённости с Ксенией от 22.09.2026 событие — дело с конкретными датой и временем; квест — дело, которое можно выполнить в любой момент до дедлайна без фиксированного времени. Эта терминология относится к работе с её делами.',
  },
  {
    key: 'quest_reminders',
    content: 'Ксения 22.09.2026 выбрала для своих квестов напоминания вечером накануне дедлайна и утром в день дедлайна. Если до срока неделя — дополнительно ежедневно до дедлайна. Эта схема касается только дел без фиксированного времени; для событий с точными датой и временем остаётся обычное напоминание заранее. Точные часы утренних, вечерних и ежедневных напоминаний не согласованы. Сохранённое пожелание не подтверждает изменение уже существующих расписаний.',
  },
  {
    key: 'gentle_teasing',
    content: 'Ксения попросила вернуть характерные усмешки Мэй в общение с ней: ей их не хватает. Ей нравится лёгкая доброжелательная ирония и мягкое поддразнивание по ситуации; шутка в каждом ответе не требуется.',
  },
];

export async function up(database: Kysely<unknown>): Promise<void> {
  const db = database as Kysely<Database>;
  await db.transaction().execute(async (transaction) => {
    const thread = await transaction.selectFrom('threads').select(['id', 'chat_id'])
      .where('id', '=', 15).forUpdate().executeTakeFirst();
    if (!thread) return;
    const users = await transaction.selectFrom('users').select('id')
      .where(sql<string>`lower(telegram_username)`, '=', 'foreignflyingfish')
      .limit(2).execute();
    if (users.length !== 1) throw new Error('Expected one user with username ForeignFlyingFish');
    const subjectUserId = Number(users[0]!.id);
    for (const record of records) {
      const values = { kind: 'procedural' as const, content: record.content,
        source_message_id: null, source_user_id: subjectUserId, source: 'reviewed_summary_migration' };
      await transaction.insertInto('memories').values({ namespace: 'chat', chat_id: thread.chat_id,
        user_id: null, subject_user_id: subjectUserId, subject_scope_id: subjectUserId, memory_key: record.key, ...values,
      }).onDuplicateKeyUpdate({ ...values, version: sql<number>`version + 1`, updated_at: new Date() }).execute();
    }
    await transaction.updateTable('threads').set({
      summary: 'Для выбранной Ксенией схемы напоминаний квестов ещё не согласованы точные часы утра, вечера и ежедневных напоминаний. Применение новых правил к уже существующим задачам не подтверждено.',
      summary_version: sql<number>`summary_version + 1`, lock_token: null, locked_at: null,
      retry_at: null, last_error: null, updated_at: new Date(),
    }).where('id', '=', thread.id).execute();
  });
}

export function down(): Promise<void> {
  throw new Error('014_reviewed_thread_memory requires a forward migration to preserve reviewed memories');
}
