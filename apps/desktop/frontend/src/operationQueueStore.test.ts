import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatSpeed,
  formatTimeRemaining,
  generateOperationId,
  useActiveOperationsCount,
  useHasActiveOperations,
  useOperationQueueStore,
  useShowProgressPanel,
  type FileOperation,
} from './operationQueueStore';

const initialState = useOperationQueueStore.getState();
const now = Date.parse('2026-06-04T12:00:00Z');

const baseOperation = {
  type: 'copy' as const,
  items: [
    {
      sourcePath: '/root/a.txt',
      destPath: '/root/b.txt',
      size: 10,
      name: 'a.txt',
      isDir: false,
    },
  ],
  destinationPath: '/root',
  totalBytes: 10,
  totalItems: 1,
  conflictResolution: 'ask' as const,
};

function operation(overrides: Partial<FileOperation> = {}): FileOperation {
  return {
    id: 'op-existing',
    type: 'copy',
    status: 'pending',
    items: baseOperation.items,
    destinationPath: '/root',
    totalBytes: 10,
    processedBytes: 0,
    totalItems: 1,
    processedItems: 0,
    failedItems: [],
    conflictResolution: 'ask',
    conflicts: [],
    abortController: new AbortController(),
    ...overrides,
  };
}

function resetStore(overrides: Partial<ReturnType<typeof useOperationQueueStore.getState>> = {}) {
  useOperationQueueStore.setState(
    {
      ...initialState,
      operations: [],
      maxConcurrent: 2,
      defaultConflictResolution: 'ask',
      showProgressPanel: false,
      onOperationComplete: null,
      ...overrides,
    },
    true
  );
}

describe('operation queue helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  it('generates monotonic operation ids and formats operation metrics', () => {
    const first = generateOperationId();
    const second = generateOperationId();
    const firstCounter = Number(first.split('-').at(-1));
    const secondCounter = Number(second.split('-').at(-1));

    expect(first).toMatch(/^op-1780574400000-\d+$/);
    expect(secondCounter).toBe(firstCounter + 1);

    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536, 2)).toBe('1.5 KB');
    expect(formatBytes(1536, -1)).toBe('2 KB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
    expect(formatTimeRemaining(0)).toBe('');
    expect(formatTimeRemaining(9_500)).toBe('9s');
    expect(formatTimeRemaining(125_000)).toBe('2m 5s');
    expect(formatTimeRemaining(3_650_000)).toBe('1h 0m');
    expect(formatSpeed(2048)).toBe('2 KB/s');
  });
});

describe('useOperationQueueStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetStore({ maxConcurrent: 1 });
  });

  it('auto-starts operations up to the concurrency limit and initializes operation state', () => {
    const id1 = useOperationQueueStore.getState().addOperation(baseOperation);
    const id2 = useOperationQueueStore.getState().addOperation(baseOperation);

    const ops = useOperationQueueStore.getState().operations;
    const op1 = ops.find((op) => op.id === id1);
    const op2 = ops.find((op) => op.id === id2);

    expect(useOperationQueueStore.getState().showProgressPanel).toBe(true);
    expect(op1).toMatchObject({
      id: id1,
      status: 'running',
      processedBytes: 0,
      processedItems: 0,
      failedItems: [],
      conflicts: [],
      startedAt: now,
    });
    expect(op1?.abortController).toBeInstanceOf(AbortController);
    expect(op2?.status).toBe('pending');
  });

  it('completes an operation, notifies listeners, and starts the next pending one', () => {
    const onComplete = vi.fn();
    useOperationQueueStore.getState().setOnOperationComplete(onComplete);

    const id1 = useOperationQueueStore.getState().addOperation(baseOperation);
    const id2 = useOperationQueueStore.getState().addOperation(baseOperation);

    useOperationQueueStore.getState().setOperationStatus(id1, 'completed');

    const ops = useOperationQueueStore.getState().operations;
    const op1 = ops.find((op) => op.id === id1);
    const op2 = ops.find((op) => op.id === id2);

    expect(op1).toMatchObject({
      status: 'completed',
      completedAt: now,
    });
    expect(op2?.status).toBe('running');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: id1, status: 'completed' })
    );
  });

  it('removes operations and clears only completed or cancelled entries', () => {
    resetStore({
      operations: [
        operation({ id: 'running', status: 'running' }),
        operation({ id: 'completed', status: 'completed' }),
        operation({ id: 'cancelled', status: 'cancelled' }),
        operation({ id: 'failed', status: 'failed' }),
      ],
    });

    useOperationQueueStore.getState().removeOperation('running');
    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual([
      'completed',
      'cancelled',
      'failed',
    ]);

    useOperationQueueStore.getState().clearCompleted();
    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual(['failed']);
  });

  it('starts, pauses, resumes, and cancels operations', () => {
    const abortController = new AbortController();
    resetStore({
      operations: [
        operation({ id: 'pending-op', status: 'pending' }),
        operation({ id: 'running-op', status: 'running' }),
        operation({ id: 'paused-op', status: 'paused' }),
        operation({ id: 'cancel-op', status: 'running', abortController }),
      ],
    });

    useOperationQueueStore.getState().startOperation('pending-op');
    useOperationQueueStore.getState().pauseOperation('running-op');
    useOperationQueueStore.getState().pauseOperation('pending-op');
    useOperationQueueStore.getState().resumeOperation('paused-op');
    useOperationQueueStore.getState().resumeOperation('running-op');
    useOperationQueueStore.getState().cancelOperation('cancel-op');
    useOperationQueueStore.getState().cancelOperation('missing');

    const byId = Object.fromEntries(
      useOperationQueueStore.getState().operations.map((op) => [op.id, op])
    );

    expect(byId['pending-op']).toMatchObject({ status: 'paused', startedAt: now });
    expect(byId['running-op'].status).toBe('running');
    expect(byId['paused-op'].status).toBe('running');
    expect(byId['cancel-op']).toMatchObject({ status: 'cancelled', completedAt: now });
    expect(abortController.signal.aborted).toBe(true);
  });

  it('retries failed operations and auto-starts only when capacity is available', () => {
    const failedController = new AbortController();
    resetStore({
      maxConcurrent: 1,
      operations: [
        operation({
          id: 'failed-op',
          status: 'failed',
          error: 'Disk full',
          failedItems: [{ path: '/root/a.txt', error: 'Disk full' }],
          processedBytes: 9,
          processedItems: 1,
          abortController: failedController,
        }),
      ],
    });

    useOperationQueueStore.getState().retryOperation('failed-op');
    const retried = useOperationQueueStore.getState().operations[0];

    expect(retried).toMatchObject({
      status: 'running',
      error: undefined,
      failedItems: [],
      processedBytes: 0,
      processedItems: 0,
      startedAt: now,
    });
    expect(retried.abortController).not.toBe(failedController);

    resetStore({
      maxConcurrent: 1,
      operations: [
        operation({ id: 'running-op', status: 'running' }),
        operation({ id: 'failed-op', status: 'failed', error: 'Network' }),
      ],
    });

    useOperationQueueStore.getState().retryOperation('failed-op');
    expect(
      useOperationQueueStore.getState().operations.find((op) => op.id === 'failed-op')
    ).toMatchObject({
      status: 'pending',
      error: undefined,
    });
  });

  it('updates progress, failed item lists, and conflict resolution state', () => {
    const id = useOperationQueueStore.getState().addOperation(baseOperation);

    useOperationQueueStore.getState().updateProgress(id, {
      processedBytes: 8,
      processedItems: 1,
      currentItem: 'a.txt',
      speed: 2048,
      estimatedTimeRemaining: 5000,
    });
    useOperationQueueStore.getState().addFailedItem(id, '/root/a.txt', 'Permission denied');
    useOperationQueueStore.getState().addConflict(id, '/root/a.txt', '/root/b.txt');
    useOperationQueueStore.getState().resolveConflict(id, 'replace');

    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      processedBytes: 8,
      processedItems: 1,
      currentItem: 'a.txt',
      speed: 2048,
      estimatedTimeRemaining: 5000,
      failedItems: [{ path: '/root/a.txt', error: 'Permission denied' }],
      conflictResolution: 'replace',
      conflicts: [],
    });
  });

  it('records failed and cancelled completion callbacks and starts queued work', () => {
    const onComplete = vi.fn();
    resetStore({ maxConcurrent: 1 });
    useOperationQueueStore.getState().setOnOperationComplete(onComplete);
    const id1 = useOperationQueueStore.getState().addOperation(baseOperation);
    const id2 = useOperationQueueStore.getState().addOperation(baseOperation);

    useOperationQueueStore.getState().setOperationStatus(id1, 'failed', 'Network down');

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: id1, status: 'failed', error: 'Network down' })
    );
    expect(useOperationQueueStore.getState().operations.find((op) => op.id === id1)).toMatchObject({
      status: 'failed',
      error: 'Network down',
      completedAt: now,
    });
    expect(useOperationQueueStore.getState().operations.find((op) => op.id === id2)?.status).toBe(
      'running'
    );

    useOperationQueueStore.getState().setOperationStatus(id2, 'cancelled');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: id2, status: 'cancelled' })
    );

    useOperationQueueStore.getState().setOperationStatus('missing', 'completed');
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('clamps settings and exposes computed operation state', () => {
    resetStore({
      operations: [
        operation({ id: 'running-op', status: 'running' }),
        operation({ id: 'pending-op', status: 'pending' }),
        operation({ id: 'paused-op', status: 'paused' }),
        operation({ id: 'completed-op', status: 'completed' }),
      ],
    });

    useOperationQueueStore.getState().setMaxConcurrent(0);
    expect(useOperationQueueStore.getState().maxConcurrent).toBe(1);
    useOperationQueueStore.getState().setMaxConcurrent(10);
    expect(useOperationQueueStore.getState().maxConcurrent).toBe(5);
    useOperationQueueStore.getState().setDefaultConflictResolution('rename');
    useOperationQueueStore.getState().setShowProgressPanel(true);

    expect(useOperationQueueStore.getState().defaultConflictResolution).toBe('rename');
    expect(useOperationQueueStore.getState().showProgressPanel).toBe(true);
    expect(
      useOperationQueueStore
        .getState()
        .getRunningOperations()
        .map((op) => op.id)
    ).toEqual(['running-op']);
    expect(
      useOperationQueueStore
        .getState()
        .getPendingOperations()
        .map((op) => op.id)
    ).toEqual(['pending-op']);
    expect(useOperationQueueStore.getState().hasActiveOperations()).toBe(true);

    resetStore({ operations: [operation({ id: 'done', status: 'completed' })] });
    expect(useOperationQueueStore.getState().hasActiveOperations()).toBe(false);
  });

  it('exposes common selector hooks', () => {
    resetStore({
      showProgressPanel: true,
      operations: [
        operation({ id: 'running-op', status: 'running' }),
        operation({ id: 'pending-op', status: 'pending' }),
        operation({ id: 'paused-op', status: 'paused' }),
      ],
    });

    expect(renderHook(() => useHasActiveOperations()).result.current).toBe(true);
    expect(renderHook(() => useShowProgressPanel()).result.current).toBe(true);
    expect(renderHook(() => useActiveOperationsCount()).result.current).toBe(2);

    resetStore({ operations: [operation({ id: 'paused-op', status: 'paused' })] });
    expect(renderHook(() => useHasActiveOperations()).result.current).toBe(false);
    expect(renderHook(() => useActiveOperationsCount()).result.current).toBe(0);
  });
});
