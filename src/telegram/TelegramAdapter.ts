import type { Api } from 'grammy';
import type { ChatMember, InlineKeyboardMarkup, MessageEntity } from 'grammy/types';

export type TelegramTextOptions = {
  entities?: MessageEntity[];
  reply_markup?: InlineKeyboardMarkup;
};

export interface TelegramGateway {
  sendText(chatId: number, text: string, options?: TelegramTextOptions): Promise<number>;
  editText(chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void>;
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

export interface TelegramMembershipGateway {
  getChatMember(chatId: number, userId: number): Promise<ChatMember>;
}

// The caller supplies the complete model-authored text. No prose is added here.
export class TelegramAdapter implements TelegramGateway, TelegramMembershipGateway {
  public constructor(private readonly api: Api) {}

  public getChatMember(chatId: number, userId: number): Promise<ChatMember> {
    return this.api.getChatMember(chatId, userId);
  }

  public async sendText(chatId: number, text: string, options?: TelegramTextOptions): Promise<number> {
    const message = await this.api.sendMessage(chatId, text, options);
    return message.message_id;
  }

  public async editText(chatId: number, messageId: number, text: string, options?: TelegramTextOptions): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, text, options);
    } catch (error) {
      if (!(error instanceof Error) || !/message is not modified/i.test(error.message)) throw error;
    }
  }

  public async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
  }
}
