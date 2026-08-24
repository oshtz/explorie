import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';
import { useOperationQueueStore } from '../operationQueueStore';

const mocks = vi.hoisted(() => ({
  runNativeFileOperation: vi.fn(),
  deletePath: vi.fn(),
  fileExists: vi.fn(),
  stat: vi.fn(),
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

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: mocks.stat,
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
  DESTINATION_CHANGED_RETRY_ERROR,
  DESTINATION_GONE_RETRY_ERROR,
  moveWithUndoAndConflictResolution,
  retryFailedOrCancelledItems,
  trackQueuedTransfer,
} from './fileOperations';

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
    mocks.stat.mockResolvedValue({
      isDirectory: true,
      birthtime: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.checkForConflict.mockResolvedValue(null);
    useOperationQueueStore.setState({
      operations: [],
      defaultConflictResolution: 'ask',
      showProgressPanel: false,
    });
    mocks.queueConflict.mockResolvedValue('skip');
    mocks.runNativeFileOperation.mockResolvedValue({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/report.txt'],
    });
    useUndoRedoStore.setState({ undoStack: [], redoStack: [] });
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
  });

  it('records per-item outcomes on a tracked partial copy', async () => {
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/one.txt'],
      })
      .mockRejectedValueOnce(new Error('disk full'));

    const operationId = trackQueuedTransfer(
      'copy',
      [file('/source/one.txt'), file('/source/two.txt')],
      '/destination',
      'ask'
    );

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/source/one.txt'), file('/source/two.txt')],
        '/destination',
        showToast,
        refresh,
        { conflictResolution: 'ask' },
        operationId
      )
    ).resolves.toBe(false);

    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.id).toBe(operationId);
    expect(operation.items.map((item) => item.outcome)).toEqual(['completed', 'failed']);
    expect(operation.outcomes).toEqual({ completed: 1, skipped: 0, failed: 1, cancelled: 0 });
    expect(useOperationQueueStore.getState().getRetryableItems(operationId)).toHaveLength(1);
  });

  it('records skipped conflicts and cancelled remaining items', async () => {
    mocks.checkForConflict.mockResolvedValue(conflict('/source/one.txt'));
    const files = [file('/source/one.txt'), file('/source/two.txt'), file('/source/three.txt')];
    const skipId = trackQueuedTransfer('copy', files, '/destination', 'skip');

    await copyWithUndoAndConflictResolution(
      files,
      '/destination',
      showToast,
      refresh,
      {
        conflictResolution: 'skip',
      },
      skipId
    );

    expect(
      useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === skipId)
        ?.items.map((item) => item.outcome)
    ).toEqual(['skipped', 'skipped', 'skipped']);

    mocks.checkForConflict.mockResolvedValue(null);
    const abort = new Error('File operation cancelled');
    abort.name = 'AbortError';
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/one.txt'],
      })
      .mockRejectedValueOnce(abort);

    const cancelId = trackQueuedTransfer('copy', files, '/destination', 'ask');
    await copyWithUndoAndConflictResolution(
      files,
      '/destination',
      showToast,
      refresh,
      undefined,
      cancelId
    );

    expect(
      useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === cancelId)
        ?.items.map((item) => item.outcome)
    ).toEqual(['completed', 'cancelled', 'cancelled']);
  });

  it('retries only failed items without duplicating completed ones', async () => {
    mocks.runNativeFileOperation
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/one.txt'],
      })
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({
        processedEntries: 1,
        processedBytes: 128,
        targets: ['/destination/two.txt'],
      });

    const files = [file('/source/one.txt'), file('/source/two.txt')];
    const operationId = trackQueuedTransfer('copy', files, '/destination', 'ask');
    await copyWithUndoAndConflictResolution(
      files,
      '/destination',
      showToast,
      refresh,
      undefined,
      operationId
    );

    mocks.runNativeFileOperation.mockClear();
    await expect(retryFailedOrCancelledItems(operationId, showToast, refresh)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'copy', sources: ['/source/two.txt'] }),
      expect.objectContaining({ queueOperationId: operationId })
    );
    const operation = useOperationQueueStore.getState().operations[0];
    expect(operation.items.map((item) => item.outcome)).toEqual(['completed', 'completed']);
    expect(useOperationQueueStore.getState().getRetryableItems(operationId)).toHaveLength(0);
  });

  it('retries a cancelled move with the original destination and conflict policy', async () => {
    const abort = new Error('File operation cancelled');
    abort.name = 'AbortError';
    mocks.runNativeFileOperation.mockRejectedValueOnce(abort).mockResolvedValueOnce({
      processedEntries: 1,
      processedBytes: 128,
      targets: ['/destination/report.txt'],
    });

    const operationId = trackQueuedTransfer('move', [file()], '/destination', 'keepBoth');
    await moveWithUndoAndConflictResolution(
      [file()],
      '/destination',
      showToast,
      refresh,
      { conflictResolution: 'keepBoth' },
      operationId
    );

    mocks.runNativeFileOperation.mockClear();
    mocks.checkForConflict.mockResolvedValue(conflict());
    await retryFailedOrCancelledItems(operationId, showToast, refresh);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'move',
        sources: ['/source/report.txt'],
        destination: '/destination',
        conflictPolicy: 'rename',
      }),
      expect.objectContaining({ queueOperationId: operationId })
    );
  });

  it('refuses retry when a source is gone', async () => {
    mocks.runNativeFileOperation.mockRejectedValueOnce(new Error('network'));
    const operationId = trackQueuedTransfer('copy', [file()], '/destination', 'ask');
    await copyWithUndoAndConflictResolution(
      [file()],
      '/destination',
      showToast,
      refresh,
      undefined,
      operationId
    );

    mocks.fileExists.mockImplementation(async (path: string) => path === '/destination');
    mocks.runNativeFileOperation.mockClear();

    await expect(retryFailedOrCancelledItems(operationId, showToast, refresh)).resolves.toBe(false);
    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('no longer at its original location'),
      { type: 'error' }
    );
  });

  it('refuses retry when the destination is gone or changed', async () => {
    mocks.runNativeFileOperation.mockRejectedValueOnce(new Error('network'));
    const operationId = trackQueuedTransfer('copy', [file()], '/destination', 'ask');
    await copyWithUndoAndConflictResolution(
      [file()],
      '/destination',
      showToast,
      refresh,
      undefined,
      operationId
    );

    mocks.fileExists.mockResolvedValue(false);
    await expect(retryFailedOrCancelledItems(operationId, showToast, refresh)).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith(DESTINATION_GONE_RETRY_ERROR, { type: 'error' });

    mocks.fileExists.mockResolvedValue(true);
    mocks.stat.mockResolvedValue({
      isDirectory: true,
      birthtime: new Date('2026-06-01T00:00:00.000Z'),
    });
    await expect(retryFailedOrCancelledItems(operationId, showToast, refresh)).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith(DESTINATION_CHANGED_RETRY_ERROR, { type: 'error' });
  });

  it('never retries a delete operation', async () => {
    useOperationQueueStore.getState().trackOperation({
      id: 'delete-1',
      type: 'delete',
      items: [{ sourcePath: '/source/report.txt', size: 128, name: 'report.txt', isDir: false }],
      totalBytes: 128,
      totalItems: 1,
      conflictResolution: 'ask',
    });
    useOperationQueueStore.getState().updateItemOutcome('delete-1', 0, 'failed', 'denied');

    await expect(retryFailedOrCancelledItems('delete-1', showToast, refresh)).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith('Cannot retry permanent delete operations', {
      type: 'error',
    });
    expect(mocks.runNativeFileOperation).not.toHaveBeenCalled();
  });
});
