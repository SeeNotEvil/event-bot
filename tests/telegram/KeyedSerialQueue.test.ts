import { describe, expect, it } from 'vitest';
import { KeyedSerialQueue } from '../../src/telegram/KeyedSerialQueue.js';

describe('KeyedSerialQueue', () => {
  it('serializes work for the same user', async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run('user', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.run('user', async () => {
      order.push('second');
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
