import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  formatBytes,
  useActiveOperationsCount,
  useHasActiveOperations,
  useOperationQueueStore,
  useShowProgressPanel,
} from './operationQueueStore';

const trackedOperation = {
  id: 'job-1',
  type: 'copy' as const,
  items: [{ sourcePath: '/a.txt', size: 10, name: 'a.txt', isDir: false }],
  destinationPath: '/target',
  totalBytes: 10,
  totalItems: 1,
  conflictResolution: 'ask' as const,
};

describe('operation queue store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOperationQueueStore.setState({
      operations: [],
      defaultConflictResolution: 'ask',
      showProgressPanel: false,
    });
  });

  it('tracks native progress and reports terminal state', () => {
    const store = useOperationQueueStore.getState();
    store.trackOperation(trackedOperation);
    useOperationQueueStore.getState().updateProgress('job-1', {
      processedBytes: 8,
      processedItems: 1,
      currentItem: '/a.txt',
    });
    useOperationQueueStore.getState().finishOperation('job-1', 'completed');

    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      status: 'completed',
      processedBytes: 8,
      processedItems: 1,
      currentItem: '/a.txt',
      outcomes: { completed: 1, skipped: 0, failed: 0, cancelled: 0 },
    });
    expect(useOperationQueueStore.getState().operations[0].items[0].outcome).toBe('completed');
  });

  it('delegates cancellation to the native job', async () => {
    invoke.mockResolvedValue(true);
    useOperationQueueStore.getState().trackOperation(trackedOperation);

    await useOperationQueueStore.getState().cancelOperation('job-1');

    expect(invoke).toHaveBeenCalledWith('cancel_file_operation', { jobId: 'job-1' });
    expect(useOperationQueueStore.getState().operations[0].status).toBe('running');
  });

  it('clears terminal operations while preserving active work', () => {
    useOperationQueueStore.getState().trackOperation(trackedOperation);
    useOperationQueueStore.getState().trackOperation({ ...trackedOperation, id: 'job-2' });
    useOperationQueueStore.getState().finishOperation('job-1', 'failed', 'disk full');
    useOperationQueueStore.getState().clearCompleted();

    expect(useOperationQueueStore.getState().operations.map((operation) => operation.id)).toEqual([
      'job-2',
    ]);
  });

  it('exposes active selectors and formatting', () => {
    useOperationQueueStore.getState().trackOperation(trackedOperation);
    expect(renderHook(() => useHasActiveOperations()).result.current).toBe(true);
    expect(renderHook(() => useShowProgressPanel()).result.current).toBe(true);
    expect(renderHook(() => useActiveOperationsCount()).result.current).toBe(1);
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536, 2)).toBe('1.5 KB');
  });

  it('retains item outcomes and cancels the active native child job', async () => {
    invoke.mockResolvedValue(true);
    useOperationQueueStore.getState().trackOperation({
      ...trackedOperation,
      items: [
        { sourcePath: '/done.txt', size: 10, name: 'done.txt', isDir: false, outcome: 'completed' },
        { sourcePath: '/retry.txt', size: 10, name: 'retry.txt', isDir: false, outcome: 'failed' },
      ],
      totalBytes: 20,
      totalItems: 2,
    });
    useOperationQueueStore.getState().updateItemOutcome('job-1', '/done.txt', 'completed');
    useOperationQueueStore
      .getState()
      .updateItemOutcome('job-1', '/retry.txt', 'failed', 'Remote unavailable');
    useOperationQueueStore.getState().registerChildJob('job-1', 'native-child-1');

    expect(useOperationQueueStore.getState().operations[0].outcomes).toEqual({
      completed: 1,
      skipped: 0,
      failed: 1,
      cancelled: 0,
    });
    expect(useOperationQueueStore.getState().getRetryableItems('job-1')).toEqual([
      expect.objectContaining({ sourcePath: '/retry.txt', outcome: 'failed' }),
    ]);

    await useOperationQueueStore.getState().cancelOperation('job-1');
    expect(invoke).toHaveBeenCalledWith('cancel_file_operation', { jobId: 'native-child-1' });
  });

  it('resets retry progress to the completed and skipped baseline', () => {
    useOperationQueueStore.getState().trackOperation({
      ...trackedOperation,
      totalBytes: 100,
      totalItems: 4,
      items: [
        { sourcePath: '/done.txt', size: 10, name: 'done.txt', isDir: false },
        { sourcePath: '/skipped.txt', size: 20, name: 'skipped.txt', isDir: false },
        { sourcePath: '/failed.txt', size: 30, name: 'failed.txt', isDir: false },
        { sourcePath: '/cancelled.txt', size: 40, name: 'cancelled.txt', isDir: false },
      ],
    });
    useOperationQueueStore.getState().updateItemOutcome('job-1', '/done.txt', 'completed');
    useOperationQueueStore.getState().updateItemOutcome('job-1', '/skipped.txt', 'skipped');
    useOperationQueueStore.getState().updateItemOutcome('job-1', '/failed.txt', 'failed');
    useOperationQueueStore.getState().updateItemOutcome('job-1', '/cancelled.txt', 'cancelled');
    useOperationQueueStore.getState().updateProgress('job-1', {
      processedBytes: 100,
      processedItems: 4,
      currentItem: '/cancelled.txt',
    });

    useOperationQueueStore.getState().beginRetryOperation('job-1');

    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      status: 'running',
      processedBytes: 30,
      processedItems: 2,
      currentItem: undefined,
    });
  });
});
