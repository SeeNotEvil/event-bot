import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { AgentContext, AgentTrigger } from '../../types/domain.js';
import { StaleAgentTask } from '../StaleAgentTask.js';
import { enqueueOnce } from '../scheduler/enqueue.js';
import { changeEventSchedules } from '../scheduler/Scheduler.js';

export async function enqueueReadinessAnswer(
  database: Kysely<Database>, chatId: number, messageId: number,
  notificationId: number, deadlineVersion: number, answer: boolean,
): Promise<boolean> {
  return database.transaction().execute(async (transaction) => {
    const reference = await transaction.selectFrom('notifications').innerJoin('events', 'events.id', 'notifications.event_id')
      .select('events.id').where('notifications.id', '=', notificationId)
      .where('events.chat_id', '=', chatId).executeTakeFirst();
    if (!reference) return false;
    const event = await transaction.selectFrom('events').selectAll().where('id', '=', Number(reference.id)).forUpdate().executeTakeFirstOrThrow();
    const question = await transaction.selectFrom('notifications').selectAll()
      .where('id', '=', notificationId).forUpdate().executeTakeFirstOrThrow();
    if (event.status !== 'active' || Number(event.deadline_version) !== deadlineVersion ||
      question.kind !== 'completion_check' || question.status !== 'sent' || question.answer !== null ||
      Number(question.deadline_version) !== deadlineVersion || Number(question.telegram_message_id) !== messageId) return false;
    const now = new Date();
    await transaction.updateTable('notifications').set({ answer: Number(answer), answered_at: now })
      .where('id', '=', notificationId).execute();
    await enqueueOnce(transaction, {
      chat_id: chatId, created_by_user_id: Number(event.user_id),
      event_id: Number(event.id), deadline_version: deadlineVersion, kind: 'readiness_response',
      source: 'automatic', remind_at_utc: now, timezone: question.timezone,
      status: 'pending', answer: Number(answer), lock_token: null, locked_at: null,
      sent_at: null, last_error: null, updated_at: now,
    });
    return true;
  });
}

export async function recordReadiness(database: Kysely<Database>, context: AgentContext) {
  const trigger = context.trigger;
  if (trigger?.kind !== 'notification' || trigger.notificationKind !== 'readiness_response') {
    throw new Error('A readiness answer from a Telegram button is required');
  }
  return database.transaction().execute(async (transaction) => {
    const event = await transaction.selectFrom('events').selectAll()
      .where('id', '=', trigger.eventId).where('chat_id', '=', context.chatId).forUpdate().executeTakeFirst();
    const response = await transaction.selectFrom('notifications').selectAll()
      .where('id', '=', trigger.notificationId).where('event_id', '=', trigger.eventId).forUpdate().executeTakeFirst();
    if (!event || !response || response.kind !== 'readiness_response' || response.answer === null ||
      Number(event.deadline_version) !== trigger.deadlineVersion || Number(response.deadline_version) !== trigger.deadlineVersion || response.status !== 'pending' ||
      (event.status !== 'active' && !response.action_applied)) throw new StaleAgentTask();
    const ready = Boolean(response.answer);
    if (!response.action_applied) {
      if (ready) {
        await changeEventSchedules(transaction, [trigger.eventId], new Date(), true);
        await transaction.updateTable('events').set({ status: 'completed', completed_at: new Date(), updated_at: new Date() })
          .where('id', '=', trigger.eventId).execute();
        await transaction.updateTable('notifications').set({
          status: 'cancelled', lock_token: null, locked_at: null, updated_at: new Date(),
        }).where('event_id', '=', trigger.eventId).where('status', '=', 'pending')
          .where('id', '!=', trigger.notificationId).execute();
      }
      await transaction.updateTable('notifications').set({ action_applied: 1 })
        .where('id', '=', trigger.notificationId).execute();
    }
    return { eventId: trigger.eventId, ready, awaitingNewDates: !ready, changed: !response.action_applied };
  });
}

export async function getRescheduleReplyContext(
  database: Kysely<Database>, chatId: number, replyToMessageId: number,
): Promise<AgentTrigger | undefined> {
  const response = await database.selectFrom('notifications').innerJoin('events', 'events.id', 'notifications.event_id')
    .select(['events.id', 'events.deadline_version'])
    .where('events.chat_id', '=', chatId).where('events.status', '=', 'active')
    .whereRef('events.deadline_version', '=', 'notifications.deadline_version')
    .where('notifications.kind', '=', 'readiness_response').where('notifications.answer', '=', 0)
    .where('notifications.action_applied', '=', 1).where('notifications.status', '=', 'sent')
    .where('notifications.telegram_message_id', '=', replyToMessageId).executeTakeFirst();
  return response ? { kind: 'reschedule_reply', eventId: Number(response.id), deadlineVersion: Number(response.deadline_version) } : undefined;
}
