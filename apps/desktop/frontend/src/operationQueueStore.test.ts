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
});
