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

  it('sends one aggregate Trash job for a multi-item delete', async () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`/source/item-${index}.txt`));

    await expect(deleteWithUndo(files, showToast, refresh)).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'trash',
        sources: files.map((entry) => entry.path),
        destination: null,
        conflictPolicy: 'error',
      },
      expect.objectContaining({
        type: 'delete',
        items: files.map((entry) => ({
          sourcePath: entry.path,
          size: 128,
          name: entry.name,
          isDir: false,
        })),
      })
    );
    expect(mocks.deletePath).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Moved 10 items to Trash', { type: 'success' });
  });

  it('reports a cancelled multi-item delete as cancelled and refreshes the view', async () => {
    const abort = new Error('File operation cancelled');
    abort.name = 'AbortError';
    mocks.runNativeFileOperation.mockRejectedValueOnce(abort);

    await expect(
      deleteWithUndo([file('/source/one.txt'), file('/source/two.txt')], showToast, refresh)
    ).resolves.toBe(false);

    expect(showToast).toHaveBeenCalledWith('Delete cancelled', { type: 'warning' });
    expect(refresh).toHaveBeenCalledTimes(1);
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
    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'copy',
        sources: ['/source/one.txt', '/source/two.txt'],
      }),
      expect.objectContaining({
        items: expect.arrayContaining([expect.anything(), expect.anything()]),
      })
    );
    expect(showToast).toHaveBeenCalledWith('Copy cancelled', { type: 'warning' });
  });

  it('uses one native job and one presentation operation for a multi-item copy', async () => {
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 2,
      processedBytes: 256,
      targets: ['/destination/one.txt', '/destination/two.txt'],
    });

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/source/one.txt'), file('/source/two.txt')],
        '/destination',
        showToast,
        refresh
      )
    ).resolves.toBe(true);

    expect(mocks.runNativeFileOperation).toHaveBeenCalledTimes(1);
    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'copy',
        sources: ['/source/one.txt', '/source/two.txt'],
        destination: '/destination',
        conflictPolicy: 'error',
      },
      expect.objectContaining({
        type: 'copy',
        items: expect.arrayContaining([
          expect.objectContaining({ sourcePath: '/source/one.txt' }),
          expect.objectContaining({ sourcePath: '/source/two.txt' }),
        ]),
      })
    );
    expect(useUndoRedoStore.getState().undoStack).toHaveLength(1);
  });

  it('preflights duplicate source names as Keep Both conflicts in one copy job', async () => {
    const first = file('/source-a/report.txt');
    const second = file('/source-b/report.txt');
    mocks.runNativeFileOperation.mockResolvedValueOnce({
      processedEntries: 2,
      processedBytes: 256,
      targets: ['/destination/report.txt', '/destination/report (1).txt'],
    });

    await expect(
      copyWithUndoAndConflictResolution([first, second], '/destination', showToast, refresh, {
        conflictResolution: 'keepBoth',
      })
    ).resolves.toBe(true);

    expect(mocks.checkForConflict).toHaveBeenCalledTimes(1);
    expect(mocks.runNativeFileOperation).toHaveBeenCalledWith(
      {
        kind: 'copy',
        sources: [first.path, second.path],
        destination: '/destination',
        conflictPolicy: 'error',
        conflictPolicies: ['error', 'rename'],
      },
      expect.objectContaining({
        type: 'copy',
        items: expect.arrayContaining([
          expect.objectContaining({ sourcePath: first.path }),
          expect.objectContaining({ sourcePath: second.path }),
        ]),
      })
    );
  });
});
