import { describe, expect, it } from 'vitest';
import { WriteQueue } from './write-queue.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('WriteQueue', () => {
  it('runs writes in FIFO order without overlap', async () => {
    const queue = new WriteQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
      return 1;
    });
    const second = queue.run(() => {
      events.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(queue.pending).toBe(2);
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    expect(queue.pending).toBe(0);
  });

  it('rejects excess work at the configured backpressure limit', async () => {
    const queue = new WriteQueue(2);
    const gate = deferred();
    const first = queue.run(async () => await gate.promise);
    const second = queue.run(() => 'queued');

    await expect(queue.run(() => 'rejected')).rejects.toThrow('Bridge busy');
    expect(queue.pending).toBe(2);

    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, 'queued']);
  });

  it('continues after both asynchronous rejection and synchronous throw', async () => {
    const queue = new WriteQueue();

    await expect(
      queue.run(async () => await Promise.reject(new Error('async failure'))),
    ).rejects.toThrow('async failure');
    await expect(
      queue.run(() => {
        throw new Error('sync failure');
      }),
    ).rejects.toThrow('sync failure');
    await expect(queue.run(() => 'recovered')).resolves.toBe('recovered');
    expect(queue.pending).toBe(0);
  });
});
