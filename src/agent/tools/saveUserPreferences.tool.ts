import type { Kysely } from 'kysely';
import {
  saveUserPreferences,
  saveUserPreferencesInputSchema,
  saveUserPreferencesOutputSchema,
} from '../../application/users/userPreferences.js';
import type { Database } from '../../db/types.js';
import { defineTool } from './Tool.js';

export function createSaveUserPreferencesTool(database: Kysely<Database>) {
  return defineTool({
    name: 'save_user_preferences',
    requiresUser: true,
    description:
      'Сохраняет цельную актуальную памятку предпочтений текущего пользователя. Используй только для явно высказанных устойчивых пожеланий или просьбы запомнить: обращение, стиль общения и привычки работы с расписанием. Нормализуй обращение «мой господин» как addressing_style: lord, «моя госпожа» как addressing_style: lady, а просьбу обойтись без гендерного обращения как addressing_style: neutral. Передавай краткую выжимку целиком, сохраняя неизменившиеся предпочтения из context и удаляя исправленные; не копируй исходные команды. Не делай выводов по косвенным признакам и не сохраняй пароли, API-ключи или платёжные данные. preferences=null означает забыть все сохранённые предпочтения.',
    input: saveUserPreferencesInputSchema,
    output: saveUserPreferencesOutputSchema,
    execute: (context, input) => {
      if (context.userId === null) throw new Error('A user request is required to change preferences');
      return saveUserPreferences(database, context.userId, input);
    },
  });
}
