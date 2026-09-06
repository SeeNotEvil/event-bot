import type { Api } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from '../../src/telegram/TelegramAdapter.js';

describe('Telegram message editing', () => {
  it('accepts an already applied edit but propagates delivery errors for retry', async () => {
    const editMessageText = vi.fn()
      .mockRejectedValueOnce(new Error('Bad Request: message is not modified'))
      .mockRejectedValueOnce(new Error('Temporary network failure'));
    const adapter = new TelegramAdapter({ editMessageText } as unknown as Api);
    await expect(adapter.editText(1, 42, 'Текст Ираиды')).resolves.toBeUndefined();
    await expect(adapter.editText(1, 42, 'Новый текст')).rejects.toThrow('Temporary network failure');
  });
});
