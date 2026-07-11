import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';

const mocks = vi.hoisted(() => ({
  runNativeFileOperation: vi.fn(),
  deletePath: vi.fn(),
  checkForConflict: vi.fn(),
  resetConflicts: vi.fn(),
  queueConflict: vi.fn(),
}));

vi.mock('./nativeFileOperations', () => ({
  runNativeFileOperation: mocks.runNativeFileOperation,
}));

vi.mock('./fs', () => ({
  deletePath: mocks.deletePath,
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
    mocks.checkForConflict.mockResolvedValue(null);
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
});
