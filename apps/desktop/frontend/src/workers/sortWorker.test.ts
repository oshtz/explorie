import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SortMessage } from './sortWorker';

type WorkerScope = typeof globalThis & {
  onmessage?: (event: MessageEvent<SortMessage>) => void;
};

async function loadWorker() {
  vi.resetModules();
  const postMessage = vi.fn();
  Object.defineProperty(globalThis, 'postMessage', {
    configurable: true,
    value: postMessage,
  });

  await import('./sortWorker');

  const workerScope = globalThis as WorkerScope;
  const send = (data: Partial<SortMessage>) => {
    if (!workerScope.onmessage) {
      throw new Error('sortWorker did not register an onmessage handler');
    }
    workerScope.onmessage({ data } as MessageEvent<SortMessage>);
  };

  return { postMessage, send };
}

describe('sortWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns invalid file payloads unchanged', async () => {
    const { postMessage, send } = await loadWorker();

    send({
      files: 'not files' as unknown as SortMessage['files'],
      key: 'name',
      dir: 'asc',
    });

    expect(postMessage).toHaveBeenCalledWith('not files');
  });

  it('sorts names from file names or paths while keeping drafts first', async () => {
    const { postMessage, send } = await loadWorker();

    send({
      key: 'name',
      dir: 'asc',
      files: [
        { path: '/workspace/zeta.txt' },
        { name: 'alpha.txt' },
        { name: 'draft.txt', is_draft: true },
      ],
    });

    expect(postMessage).toHaveBeenLastCalledWith([
      { name: 'draft.txt', is_draft: true },
      { name: 'alpha.txt' },
      { path: '/workspace/zeta.txt' },
    ]);

    send({
      key: 'name',
      dir: 'desc',
      files: [{ name: 'alpha.txt' }, { name: 'zeta.txt' }],
    });

    expect(postMessage).toHaveBeenLastCalledWith([{ name: 'zeta.txt' }, { name: 'alpha.txt' }]);
  });

  it('sorts by size and modified timestamps across supported timestamp shapes', async () => {
    const { postMessage, send } = await loadWorker();

    send({
      key: 'size',
      dir: 'desc',
      files: [{ name: 'small', size: 10 }, { name: 'large', size: 400 }, { name: 'missing-size' }],
    });

    expect(postMessage).toHaveBeenLastCalledWith([
      { name: 'large', size: 400 },
      { name: 'small', size: 10 },
      { name: 'missing-size' },
    ]);

    send({
      key: 'modified',
      dir: 'asc',
      files: [
        { name: 'date', modified: '2026-01-03 12:00:00' },
        { name: 'seconds', modified: 1_704_067_200 },
        { name: 'millis', modified: { ms: 1_704_153_600_000 } },
        {
          name: 'nested',
          modified: {
            inner: {
              secs_since_epoch: '1704240000',
              nanos_since_epoch: '500000000',
            },
          },
        },
      ],
    });

    expect(postMessage.mock.calls.at(-1)?.[0].map((file: { name: string }) => file.name)).toEqual([
      'seconds',
      'millis',
      'nested',
      'date',
    ]);
  });

  it('sorts by custom string, number, null, and missing values', async () => {
    const { postMessage, send } = await loadWorker();

    send({
      key: 'owner',
      dir: 'asc',
      files: [
        { name: 'missing', custom: {} },
        { name: 'zoe', custom: { owner: 'Zoe' } },
        { name: 'ana', custom: { owner: 'Ana' } },
      ],
    });

    expect(postMessage.mock.calls.at(-1)?.[0].map((file: { name: string }) => file.name)).toEqual([
      'ana',
      'zoe',
      'missing',
    ]);

    send({
      key: 'priority',
      dir: 'desc',
      files: [
        { name: 'low', custom: { priority: 1 } },
        { name: 'unset', custom: { priority: null } },
        { name: 'high', custom: { priority: 3 } },
        { name: 'missing', custom: {} },
      ],
    });

    expect(postMessage.mock.calls.at(-1)?.[0].map((file: { name: string }) => file.name)).toEqual([
      'missing',
      'high',
      'low',
      'unset',
    ]);
  });
});
