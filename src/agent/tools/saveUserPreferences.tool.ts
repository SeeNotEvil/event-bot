import type { Kysely } from 'kysely';
import {
  saveUserPreferences,
  saveUserPreferencesInputSchema,
  saveUserPreferencesOutputSchema,
} from '../../application/users/userPreferences.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';
import { canWriteMemory } from './memory.tools.js';
import { MysqlMemoryStore } from '../../application/memory/MysqlMemoryStore.js';

export function createSaveUserPreferencesTool(database: Kysely<Database>) {
  return defineTool({
    name: 'save_user_preferences',
    requiresUser: true,
    availableWhen: (context) => context.chatType === 'personal' && canWriteMemory(context),
    description:
      'Сохраняет цельную актуальную памятку предпочтений текущего пользователя. Используй только для явно высказанных устойчивых пожеланий или просьбы запомнить: обращение, стиль общения и привычки работы с расписанием. Нормализуй обращение «мой господин» как addressing_style: lord, «моя госпожа» как addressing_style: lady, а просьбу обойтись без гендерного обращения как addressing_style: neutral. Передавай краткую выжимку целиком, сохраняя неизменившиеся предпочтения из context и удаляя исправленные; не копируй исходные команды. Не делай выводов по косвенным признакам и не сохраняй пароли, API-ключи или платёжные данные. preferences=null означает забыть все сохранённые предпочтения.',
    input: saveUserPreferencesInputSchema,
    output: saveUserPreferencesOutputSchema,
    execute: async (context, input) => {
      if (context.userId === null || context.chatType !== 'personal' || !canWriteMemory(context)) throw new Error('A private user request is required to change preferences');
      const result = await saveUserPreferences(database, context.userId, input,
        { messageId: context.sourceMessageId!, label: 'addressed_message' }, context.memory?.profile?.version ?? null);
      context.userPreferences = result.preferences;
      if (context.memory) context.memory.profile = await new MysqlMemoryStore(database).get(context.memory.namespace, 'profile');
      return result;
    },
  });
}
