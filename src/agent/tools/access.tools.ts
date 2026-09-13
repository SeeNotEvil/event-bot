import { z } from 'zod';
import { AccessDeniedError, type BotAccess, isLiveRequest, telegramUserIdSchema } from '../../application/access/BotAccess.js';
import type { AgentContext } from '../../types/domain.js';
import { defineTool } from './Tool.js';

export function createAccessTools(access: BotAccess) {
  const availableWhen = (context: AgentContext) => access.isOwner(context.telegramUserId) && isLiveRequest(context);
  const requireOwner = (context: AgentContext) => {
    if (!availableWhen(context)) throw new AccessDeniedError();
  };
  const common = { access: 'owner' as const, requiresUser: true, availableWhen };
  return [
    defineTool({ ...common, name: 'list_allowed_users',
      description: 'Показывает владельцу глобальный список доступа к боту. Владелец имеет доступ автоматически. afterId=null — первая страница; nextAfterId — следующая. Доступно только в текущем обращении владельца, никогда в фоне.',
      input: z.object({ afterId: telegramUserIdSchema.nullable() }),
      output: z.object({ ownerTelegramUserId: telegramUserIdSchema, nextAfterId: telegramUserIdSchema.nullable(),
        users: z.array(z.object({ telegramUserId: telegramUserIdSchema, firstName: z.string().nullable(), lastName: z.string().nullable(),
          username: z.string().nullable(), addedByTelegramUserId: telegramUserIdSchema, createdAt: z.string() })) }),
      execute: async (context, input) => { requireOwner(context); return access.list(context.telegramUserId, input.afterId); },
    }),
    defineTool({ ...common, name: 'allow_user',
      description: 'По явной текущей просьбе владельца разрешает человеку общаться с ботом и сохранять данные во всех чатах. telegramUserId возьми из access_target_telegram_user_id текущего Reply либо из числового ID, явно указанного владельцем. Не угадывай ID по имени или username. Повторное добавление безопасно. /allow означает эту операцию.',
      input: z.object({ telegramUserId: telegramUserIdSchema }),
      output: z.object({ success: z.boolean(), changed: z.boolean() }),
      execute: async (context, input) => { requireOwner(context); return access.allow(context.telegramUserId, input.telegramUserId); },
    }),
    defineTool({ ...common, name: 'deny_user',
      description: 'По явной текущей просьбе владельца отзывает доступ человека во всех чатах и отменяет его ожидающие поручения и уведомления. Владелец защищён от удаления. telegramUserId возьми из текущего Reply, явного числового ID или list_allowed_users; при неоднозначности уточни. /deny означает эту операцию. Повторное добавление не возобновляет отменённые поручения.',
      input: z.object({ telegramUserId: telegramUserIdSchema }),
      output: z.object({ success: z.boolean(), changed: z.boolean(), reason: z.literal('OWNER_PROTECTED').nullable() }),
      execute: async (context, input) => { requireOwner(context); return access.deny(context.telegramUserId, input.telegramUserId); },
    }),
  ];
}
