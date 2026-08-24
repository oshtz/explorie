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
    });
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

  it('records item outcomes and only retries failed or cancelled copy/move items', () => {
    const store = useOperationQueueStore.getState();
    store.trackOperation({
      ...trackedOperation,
      items: [
        { sourcePath: '/a.txt', size: 10, name: 'a.txt', isDir: false },
        { sourcePath: '/b.txt', size: 20, name: 'b.txt', isDir: false },
        { sourcePath: '/c.txt', size: 30, name: 'c.txt', isDir: false },
      ],
      totalBytes: 60,
      totalItems: 3,
    });
    store.updateItemOutcome('job-1', 0, 'completed');
    store.updateItemOutcome('job-1', 1, 'failed', 'disk full');
    store.updateItemOutcome('job-1', 2, 'cancelled', 'Operation cancelled');
    store.setOperationOutcomeCounts('job-1', {
      completed: 1,
      skipped: 0,
      failed: 1,
      cancelled: 1,
    });
    store.finishOperation('job-1', 'cancelled');

    expect(store.getRetryableItems('job-1').map((item) => item.sourcePath)).toEqual([
      '/b.txt',
      '/c.txt',
    ]);

    store.beginRetryOperation('job-1');
    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      status: 'running',
      processedItems: 1,
      processedBytes: 10,
      error: undefined,
    });
  });

  it('does not expose retryable items for delete operations', () => {
    const store = useOperationQueueStore.getState();
    store.trackOperation({
      ...trackedOperation,
      id: 'delete-1',
      type: 'delete',
      destinationPath: undefined,
    });
    store.updateItemOutcome('delete-1', 0, 'failed', 'denied');

    expect(store.getRetryableItems('delete-1')).toEqual([]);
  });

  it('cancels the in-flight native job when a parent operation has one', async () => {
    invoke.mockResolvedValue(true);
    const store = useOperationQueueStore.getState();
    store.trackOperation(trackedOperation);
    store.setNativeJobId('job-1', 'native-9');

    await store.cancelOperation('job-1');

    expect(invoke).toHaveBeenCalledWith('cancel_file_operation', { jobId: 'native-9' });
  });
});
