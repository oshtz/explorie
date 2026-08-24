import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';

const mocks = vi.hoisted(() => ({
  runNativeFileOperation: vi.fn(),
  deletePath: vi.fn(),
  fileExists: vi.fn(),
  checkForConflict: vi.fn(),
  resetConflicts: vi.fn(),
  queueConflict: vi.fn(),
}));

vi.mock('./nativeFileOperations', () => ({
  runNativeFileOperation: mocks.runNativeFileOperation,
}));

vi.mock('./fs', () => ({
  deletePath: mocks.deletePath,
  fileExists: mocks.fileExists,
}));

vi.mock('../conflictResolutionStore', () => ({
  checkForConflict: mocks.checkForConflict,
  useConflictResolutionStore: {
    getState: () => ({
      reset: mocks.resetConflicts,
      queueConflict: mocks.queueConflict,
    }),
  },
}));

import {
  copyWithUndoAndConflictResolution,
  deleteWithUndo,
  moveWithUndoAndConflictResolution,
  retryFailedOrCancelledItems,
} from './fileOperations';
import { useOperationQueueStore } from '../operationQueueStore';

function file(path = '/source/report.txt'): FileEntry {
  return {
    id: path,
    path,
    name: path.split('/').pop() || path,
    size: 128,
    modified: new Date().toISOString(),
    hidden: false,
    is_dir: false,
    custom: {},
  };
}

function conflict(sourcePath = '/source/report.txt') {
  return {
    sourcePath,
    sourceName: 'report.txt',
    sourceIsDir: false,
    destPath: '/destination/report.txt',
    destName: 'report.txt',
    destIsDir: false,
  };
}

describe('native-backed file operations', () => {
  const showToast = vi.fn();
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    refresh.mockResolvedValue(undefined);
    mocks.deletePath.mockResolvedValue(undefined);
    mocks.fileExists.mockResolvedValue(true);
    mocks.checkForConflict.mockResolvedValue(null);
    mocks.queueConflict.mockResolvedValue('skip');
    mocks.runNativeFileOperation.mockResolvedValue({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/report.txt'],
    });
    useUndoRedoStore.setState({ undoStack: [], redoStack: [] });
    useOperationQueueStore.setState({ operations: [], showProgressPanel: false });
    window.localStorage.removeItem('explorie:remoteDrives');
  });

  it('fails closed when the operating system Trash rejects an item', async () => {
    mocks.runNativeFileOperation.mockRejectedValueOnce(new Error('Trash unavailable'));

    await expect(deleteWithUndo([file()], showToast, refresh)).resolves.toBe(false);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'trash',
        sources: ['/source/report.txt'],
        destination: null,
        conflictPolicy: 'error',
      },
      expect.objectContaining({ type: 'delete' })
    );
    expect(mocks.deletePath).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Trash unavailable'), {
      type: 'error',
    });
  });

  it('permanently deletes only when explicitly requested', async () => {
    await expect(deleteWithUndo([file()], showToast, refresh, { permanent: true })).resolves.toBe(
      true
    );

    expect(mocks.deletePath).toHaveBeenCalledWith('/source/report.txt', true);
    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
  });

  it('fails closed before starting a non-atomic multi-item Trash request', async () => {
    await expect(
      deleteWithUndo([file('/source/one.txt'), file('/source/two.txt')], showToast, refresh)
    ).resolves.toBe(false);

    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
    expect(mocks.deletePath).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('one item at a time'), {
      type: 'warning',
    });
  });

  it('routes Replace through the transactional native copy policy', async () => {
    mocks.checkForConflict.mockResolvedValue(conflict());

    await expect(
      copyWithUndoAndConflictResolution([file()], '/destination', showToast, refresh, {
        conflictResolution: 'replace',
      })
    ).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'copy',
        sources: ['/source/report.txt'],
        destination: '/destination',
        conflictPolicy: 'replace',
      },
      expect.objectContaining({ type: 'copy', conflictResolution: 'replace' })
    );
    expect(useUndoRedoStore.getState().undoStack).toEqual([]);
    expect(showToast).toHaveBeenLastCalledWith(expect.stringContaining('cannot be undone'), {
      type: 'success',
    });
  });

  it('preserves rename-on-conflict when redoing a Keep Both copy', async () => {
    mocks.checkForConflict.mockResolvedValue(conflict());

    await copyWithUndoAndConflictResolution([file()], '/destination', showToast, refresh, {
      conflictResolution: 'keepBoth',
    });
    const operation = useUndoRedoStore.getState().undoStack[0];
    await operation.undo();
    await operation.redo();

    expect(mocks.runNativeFileOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'copy', conflictPolicy: 'rename' }),
      expect.objectContaining({ type: 'copy', conflictResolution: 'rename' })
    );
  });

  it('maps Keep Both to native rename-on-conflict for moves', async () => {
    mocks.checkForConflict.mockResolvedValue(conflict());

    await expect(
      moveWithUndoAndConflictResolution([file()], '/destination', showToast, refresh, {
        conflictResolution: 'keepBoth',
      })
    ).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'move',
        sources: ['/source/report.txt'],
        destination: '/destination',
        conflictPolicy: 'rename',
      },
      expect.objectContaining({ type: 'move', conflictResolution: 'rename' })
    );
  });

  it('does not start a native job when a conflict is skipped', async () => {
    mocks.checkForConflict.mockResolvedValue(conflict());

    await expect(
      copyWithUndoAndConflictResolution([file()], '/destination', showToast, refresh, {
        conflictResolution: 'skip',
      })
    ).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('All files were skipped', { type: 'info' });
    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.items[0].outcome).toBe('skipped');
    expect(operation.outcomes).toEqual({ completed: 0, skipped: 1, failed: 0, cancelled: 0 });
    expect(useOperationQueueStore.getState().getRetryableItems(operation.id)).toEqual([]);
  });

  it('stops a multi-item copy when the active native job is cancelled', async () => {
    const abort = new Error('File operation cancelled');
    abort.name = 'AbortError';
    mocks.runNativeFileOperation.mockRejectedValueOnce(abort);

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/source/one.txt'), file('/source/two.txt')],
        '/destination',
        showToast,
        refresh
      )
    ).resolves.toBe(false);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Copy cancelled', { type: 'warning' });

    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.outcomes).toEqual({ completed: 0, skipped: 0, failed: 0, cancelled: 2 });
    expect(useOperationQueueStore.getState().getRetryableItems(operation.id)).toHaveLength(2);
  });

  it('retains mixed outcomes and offers one retry for the failed source', async () => {
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/one.txt'],
      })
      .mockRejectedValueOnce(new Error('Remote temporarily unavailable'))
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/three.txt'],
      });

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/source/one.txt'), file('/source/two.txt'), file('/source/three.txt')],
        '/destination',
        showToast,
        refresh,
        { conflictResolution: 'keepBoth' }
      )
    ).resolves.toBe(false);

    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.outcomes).toEqual({ completed: 2, skipped: 0, failed: 1, cancelled: 0 });
    expect(operation.items.map((item) => item.outcome)).toEqual([
      'completed',
      'failed',
      'completed',
    ]);
    expect(operation.conflictResolution).toBe('rename');

    mocks.checkForConflict.mockResolvedValue(conflict('/source/two.txt'));
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/two (1).txt'],
    });

    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(4);
    expect(mocks.runNativeFileOperation).toHaveBeenLastCalledWith(
      {
        kind: 'copy',
        sources: ['/source/two.txt'],
        destination: '/destination',
        conflictPolicy: 'rename',
      },
      expect.objectContaining({ conflictResolution: 'rename' })
    );
    expect(useOperationQueueStore.getState().operations[0].outcomes).toEqual({
      completed: 3,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('retries only the unresolved move item with its original policy', async () => {
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/one.txt'],
      })
      .mockRejectedValueOnce(new Error('Remote temporarily unavailable'));

    await expect(
      moveWithUndoAndConflictResolution(
        [file('/source/one.txt'), file('/source/two.txt')],
        '/destination',
        showToast,
        refresh,
        { conflictResolution: 'replace' }
      )
    ).resolves.toBe(false);

    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.outcomes).toEqual({ completed: 1, skipped: 0, failed: 1, cancelled: 0 });

    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/two.txt'],
    });
    mocks.checkForConflict.mockResolvedValue(conflict('/source/two.txt'));

    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(3);
    expect(mocks.runNativeFileOperation).toHaveBeenLastCalledWith(
      {
        kind: 'move',
        sources: ['/source/two.txt'],
        destination: '/destination',
        conflictPolicy: 'replace',
      },
      expect.objectContaining({ type: 'move', conflictResolution: 'replace' })
    );
    expect(useOperationQueueStore.getState().operations[0].outcomes).toEqual({
      completed: 2,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it('refuses retry when a source is gone or the destination changed', async () => {
    mocks.runNativeFileOperation.mockRejectedValueOnce(new Error('Source is missing'));
    await copyWithUndoAndConflictResolution(
      [file('/source/missing.txt')],
      '/destination',
      showToast,
      refresh
    );
    const operation = useOperationQueueStore.getState().operations[0];
    mocks.fileExists.mockImplementation(async (path: string) => path !== '/source/missing.txt');
    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(
      false
    );
    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('source is no longer available'),
      {
        type: 'error',
      }
    );

    useOperationQueueStore.setState({
      operations: [
        {
          ...operation,
          destinationSnapshot: '/original-destination',
          status: 'failed',
        },
      ],
    });
    mocks.fileExists.mockResolvedValue(true);
    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(
      false
    );
    expect(showToast).toHaveBeenCalledWith('Cannot retry: the original destination has changed.', {
      type: 'error',
    });
  });

  it('retries only failed items after a mixed skip and copy', async () => {
    mocks.checkForConflict.mockImplementation(async (sourcePath: string) =>
      sourcePath.endsWith('skip.txt') ? conflict(sourcePath) : null
    );
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/ok.txt'],
      })
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/source/skip.txt'), file('/source/ok.txt'), file('/source/fail.txt')],
        '/destination',
        showToast,
        refresh,
        { conflictResolution: 'skip' }
      )
    ).resolves.toBe(false);

    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.outcomes).toEqual({ completed: 1, skipped: 1, failed: 1, cancelled: 0 });
    expect(operation.items.map((item) => item.outcome)).toEqual(['skipped', 'completed', 'failed']);

    mocks.checkForConflict.mockResolvedValue(null);
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/fail.txt'],
    });

    await expect(retryFailedOrCancelledItems(operation.id, showToast)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(3);
    expect(mocks.runNativeFileOperation).toHaveBeenLastCalledWith(
      {
        kind: 'copy',
        sources: ['/source/fail.txt'],
        destination: '/destination',
        conflictPolicy: 'error',
      },
      expect.objectContaining({ type: 'copy', operationId: operation.id, trackOperation: false })
    );
    expect(useOperationQueueStore.getState().operations[0].outcomes).toEqual({
      completed: 2,
      skipped: 1,
      failed: 0,
      cancelled: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('never offers retry for delete operations', async () => {
    useOperationQueueStore.getState().trackOperation({
      id: 'delete-job',
      type: 'delete',
      items: [
        { sourcePath: '/source/a.txt', name: 'a.txt', size: 1, isDir: false, outcome: 'failed' },
      ],
      totalBytes: 1,
      totalItems: 1,
      conflictResolution: 'ask',
    });
    useOperationQueueStore.getState().finishOperation('delete-job', 'failed', 'Trash unavailable');

    await expect(retryFailedOrCancelledItems('delete-job', showToast, refresh)).resolves.toBe(
      false
    );
    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Delete operations cannot be retried.', {
      type: 'error',
    });
  });

  it('allows a transient remote failure to be retried while the mount recovers', async () => {
    mocks.runNativeFileOperation.mockRejectedValueOnce(new Error('Remote unavailable'));
    await copyWithUndoAndConflictResolution(
      [file('/remote/source.txt')],
      '/remote/destination',
      showToast,
      refresh
    );
    const operation = useOperationQueueStore.getState().operations[0];
    mocks.fileExists.mockResolvedValue(false);
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/remote/destination/source.txt'],
    });

    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(true);
    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('allows a generic mounted-remote failure to retry after the mount is unavailable', async () => {
    window.localStorage.setItem(
      'explorie:remoteDrives',
      JSON.stringify([
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'Remote',
          remote: 'cloud',
          remotePath: '',
          mountTarget: 'R:',
        },
      ])
    );
    mocks.runNativeFileOperation.mockRejectedValueOnce(
      new Error('The system cannot find the path specified.')
    );
    await copyWithUndoAndConflictResolution(
      [file('R:\\source.txt')],
      'R:\\destination',
      showToast,
      refresh
    );
    const operation = useOperationQueueStore.getState().operations[0];
    mocks.fileExists.mockResolvedValue(false);
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['R:\\destination\\source.txt'],
    });

    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(2);
    expect(showToast).not.toHaveBeenCalledWith(
      'Cannot retry: the original destination is no longer available.',
      { type: 'error' }
    );
  });

  it('refuses a generic remote missing-source error when the configured mount is available', async () => {
    window.localStorage.setItem(
      'explorie:remoteDrives',
      JSON.stringify([
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          name: 'Remote',
          remote: 'cloud',
          remotePath: '',
          mountTarget: 'R:',
        },
      ])
    );
    mocks.runNativeFileOperation.mockRejectedValueOnce(
      new Error('The system cannot find the path specified.')
    );
    await copyWithUndoAndConflictResolution(
      [file('R:\\missing.txt')],
      'R:\\destination',
      showToast,
      refresh
    );
    const operation = useOperationQueueStore.getState().operations[0];
    mocks.fileExists.mockImplementation(
      async (path: string) =>
        path.replace(/[\\/]+$/, '').toLowerCase() === 'r:' || path === 'R:\\destination'
    );

    await expect(retryFailedOrCancelledItems(operation.id, showToast, refresh)).resolves.toBe(
      false
    );

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('source is no longer available'),
      { type: 'error' }
    );
  });
});
