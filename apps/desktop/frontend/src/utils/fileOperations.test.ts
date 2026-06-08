import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import {
  copyWithUndo,
  copyWithUndoAndConflictResolution,
  createFileWithUndo,
  createFolderWithUndo,
  deleteWithUndo,
  moveWithUndo,
  moveWithUndoAndConflictResolution,
  renameWithUndo,
} from './fileOperations';

const mocks = vi.hoisted(() => ({
  deletePath: vi.fn(),
  renamePath: vi.fn(),
  moveToFolder: vi.fn(),
  copyPathToDir: vi.fn(),
  createFolderIn: vi.fn(),
  createNoteIn: vi.fn(),
  joinPaths: vi.fn((...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/')),
  fileExists: vi.fn(),
  uniquePath: vi.fn(),
  push: vi.fn(),
  undo: vi.fn(),
  generateOperationId: vi.fn(() => 'op-test'),
  readBinaryFile: vi.fn(),
  writeBinaryFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  remove: vi.fn(),
  clearDirSizeCache: vi.fn(),
  ensureTrashDir: vi.fn(),
  isTrashPath: vi.fn(),
  resetConflicts: vi.fn(),
  queueConflict: vi.fn(),
  checkForConflict: vi.fn(),
  showToast: vi.fn(),
  onRefresh: vi.fn(),
}));

vi.mock('./fs', () => ({
  deletePath: mocks.deletePath,
  renamePath: mocks.renamePath,
  moveToFolder: mocks.moveToFolder,
  copyPathToDir: mocks.copyPathToDir,
  createFolderIn: mocks.createFolderIn,
  createNoteIn: mocks.createNoteIn,
  joinPaths: mocks.joinPaths,
  fileExists: mocks.fileExists,
  uniquePath: mocks.uniquePath,
}));

vi.mock('../undoRedoStore', () => ({
  generateOperationId: mocks.generateOperationId,
  useUndoRedoStore: {
    getState: () => ({
      push: mocks.push,
      undo: mocks.undo,
    }),
  },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: mocks.readBinaryFile,
  writeFile: mocks.writeBinaryFile,
  mkdir: mocks.mkdir,
  rename: mocks.rename,
  stat: mocks.stat,
  remove: mocks.remove,
}));

vi.mock('../dirSizeCache', () => ({
  clearDirSizeCache: mocks.clearDirSizeCache,
}));

vi.mock('./trash', () => ({
  ensureTrashDir: mocks.ensureTrashDir,
  isTrashPath: mocks.isTrashPath,
  TRASH_FOLDER_NAME: '.explorie-trash',
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

function file(path: string, name = path.split('/').pop() || path, isDir = false): FileEntry {
  return {
    id: path,
    path,
    name,
    is_dir: isDir,
    size: 0,
    modified: 0,
    custom: {},
  };
}

function latestOperation<
  T extends { undo?: () => Promise<boolean>; redo?: () => Promise<boolean> },
>(): T {
  return mocks.push.mock.calls.at(-1)?.[0] as T;
}

function latestToastOptions(): {
  type?: string;
  action?: { label: string; onClick: () => void | Promise<void> };
} {
  return mocks.showToast.mock.calls.at(-1)?.[1] as {
    type?: string;
    action?: { label: string; onClick: () => void | Promise<void> };
  };
}

describe('fileOperations undo wrappers', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        mock.mockReset();
      }
    }
    mocks.generateOperationId.mockReturnValue('op-test');
    mocks.joinPaths.mockImplementation((...parts: string[]) =>
      parts.filter(Boolean).join('/').replace(/\/+/g, '/')
    );
  });

  it('renames files, pushes undo metadata, and supports undo/redo callbacks', async () => {
    mocks.renamePath.mockResolvedValue('/dir/new.txt');

    await expect(
      renameWithUndo('/dir/old.txt', 'new.txt', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe('/dir/new.txt');

    expect(mocks.renamePath).toHaveBeenCalledWith('/dir/old.txt', 'new.txt');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'rename' }));
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Renamed to "new.txt"',
      expect.objectContaining({ type: 'success' })
    );
    expect(mocks.onRefresh).toHaveBeenCalledTimes(1);

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.renamePath).toHaveBeenCalledWith('/dir/new.txt', 'old.txt');
    expect(mocks.renamePath).toHaveBeenCalledWith('/dir/old.txt', 'new.txt');
  });

  it('does not push an undo operation when a rename keeps the same name', async () => {
    await expect(
      renameWithUndo('/dir/same.txt', 'same.txt', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe('/dir/same.txt');

    expect(mocks.renamePath).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.onRefresh).not.toHaveBeenCalled();
  });

  it('moves files and exposes undo/redo through the undo stack', async () => {
    mocks.moveToFolder.mockResolvedValue(undefined);

    await expect(
      moveWithUndo([file('/src/a.txt')], '/dest', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(true);

    expect(mocks.moveToFolder).toHaveBeenCalledWith('/src/a.txt', '/dest');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Moved a.txt',
      expect.objectContaining({ type: 'success' })
    );

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.moveToFolder).toHaveBeenCalledWith('/dest/a.txt', '/src');
    expect(mocks.moveToFolder).toHaveBeenCalledWith('/src/a.txt', '/dest');
  });

  it('tracks partial move failures and lets the toast action roll back completed moves', async () => {
    mocks.moveToFolder.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('blocked'));

    await expect(
      moveWithUndo(
        [file('/src/a.txt'), file('/src/b.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh
      )
    ).resolves.toBe(false);

    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Moved 1 item(s), but 1 failed'),
      expect.objectContaining({
        type: 'warning',
        action: expect.objectContaining({ label: 'Undo' }),
      })
    );

    await latestToastOptions().action?.onClick();
    expect(mocks.moveToFolder).toHaveBeenCalledWith('/dest/a.txt', '/src');
  });

  it('copies files and supports undo/redo of created paths', async () => {
    mocks.copyPathToDir.mockResolvedValue('/dest/a.txt');
    mocks.fileExists.mockResolvedValue(true);
    mocks.deletePath.mockResolvedValue(undefined);

    await expect(
      copyWithUndo([file('/src/a.txt')], '/dest', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(true);

    expect(mocks.copyPathToDir).toHaveBeenCalledWith('/src/a.txt', '/dest');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'copy' }));

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.deletePath).toHaveBeenCalledWith('/dest/a.txt', true);
    expect(mocks.copyPathToDir).toHaveBeenCalledTimes(2);
  });

  it('creates folders with undo and redo callbacks', async () => {
    mocks.createFolderIn.mockResolvedValue('/dir/New Folder');
    mocks.fileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.deletePath.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);

    await expect(
      createFolderWithUndo('/dir', 'New Folder', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe('/dir/New Folder');

    expect(mocks.push).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'create', itemType: 'folder' })
    );

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.deletePath).toHaveBeenCalledWith('/dir/New Folder', true);
    expect(mocks.mkdir).toHaveBeenCalledWith('/dir/New Folder');
  });

  it('creates files with undo and redo callbacks using provided content', async () => {
    mocks.createNoteIn.mockResolvedValue('/dir/note.md');
    mocks.fileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.deletePath.mockResolvedValue(undefined);
    mocks.writeBinaryFile.mockResolvedValue(undefined);

    await expect(
      createFileWithUndo('/dir', 'note.md', 'body', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe('/dir/note.md');

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.deletePath).toHaveBeenCalledWith('/dir/note.md', false);
    expect(mocks.writeBinaryFile).toHaveBeenCalledWith(
      '/dir/note.md',
      new TextEncoder().encode('body')
    );
  });

  it('moves deletions to trash, pushes restore metadata, and handles undo/redo', async () => {
    mocks.ensureTrashDir.mockResolvedValue('/trash');
    mocks.isTrashPath.mockReturnValue(false);
    mocks.uniquePath.mockResolvedValue('/trash/a.txt');
    mocks.rename.mockResolvedValue(undefined);
    mocks.fileExists.mockResolvedValue(true);

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(true);

    expect(mocks.rename).toHaveBeenCalledWith('/src/a.txt', '/trash/a.txt');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'delete' }));

    const operation = latestOperation<{
      undo: () => Promise<boolean>;
      redo: () => Promise<boolean>;
    }>();
    await expect(operation.undo()).resolves.toBe(true);
    await expect(operation.redo()).resolves.toBe(true);
    expect(mocks.rename).toHaveBeenCalledWith('/trash/a.txt', '/src/a.txt');
    expect(mocks.rename).toHaveBeenCalledWith('/src/a.txt', '/trash/a.txt');
  });

  it('permanently deletes files without pushing undo metadata when requested', async () => {
    mocks.deletePath.mockResolvedValue(undefined);

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh, { permanent: true })
    ).resolves.toBe(true);

    expect(mocks.ensureTrashDir).not.toHaveBeenCalled();
    expect(mocks.deletePath).toHaveBeenCalledWith('/src/a.txt', true);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Permanently deleted a.txt', { type: 'warning' });
  });

  it('returns false without side effects when deleting no files', async () => {
    await expect(deleteWithUndo([], mocks.showToast, mocks.onRefresh)).resolves.toBe(false);

    expect(mocks.ensureTrashDir).not.toHaveBeenCalled();
    expect(mocks.deletePath).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.onRefresh).not.toHaveBeenCalled();
  });

  it('falls back to permanent delete when trash setup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.ensureTrashDir.mockRejectedValue(new Error('trash unavailable'));
    mocks.deletePath.mockResolvedValue(undefined);

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(true);

    expect(mocks.deletePath).toHaveBeenCalledWith('/src/a.txt', true);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Trash unavailable, items were deleted permanently',
      { type: 'warning' }
    );
    expect(mocks.onRefresh).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });

  it('reports failure when trash setup and fallback permanent delete both fail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.ensureTrashDir.mockRejectedValue(new Error('trash unavailable'));
    mocks.deletePath.mockRejectedValue(new Error('locked'));

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(false);

    expect(mocks.deletePath).toHaveBeenCalledWith('/src/a.txt', true);
    expect(mocks.showToast).toHaveBeenCalledWith('Failed to delete: Trash unavailable', {
      type: 'error',
    });
    expect(mocks.onRefresh).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('creates a local trash directory when no global trash directory is available', async () => {
    mocks.ensureTrashDir.mockResolvedValue(null);
    mocks.isTrashPath.mockReturnValue(false);
    mocks.fileExists.mockResolvedValue(false);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.uniquePath.mockResolvedValue('/src/.explorie-trash/a.txt');
    mocks.rename.mockResolvedValue(undefined);

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(true);

    expect(mocks.mkdir).toHaveBeenCalledWith('/src/.explorie-trash');
    expect(mocks.uniquePath).toHaveBeenCalledWith('/src/.explorie-trash', 'a.txt');
    expect(mocks.rename).toHaveBeenCalledWith('/src/a.txt', '/src/.explorie-trash/a.txt');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'delete' }));
  });

  it('returns false when a permanent delete fails', async () => {
    mocks.deletePath.mockRejectedValue(new Error('permission denied'));

    await expect(
      deleteWithUndo([file('/src/a.txt')], mocks.showToast, mocks.onRefresh, { permanent: true })
    ).resolves.toBe(false);

    expect(mocks.showToast).toHaveBeenCalledWith(
      "Failed to delete items from Trash: Access denied - you don't have permission for this operation",
      { type: 'error' }
    );
    expect(mocks.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('returns null and reports a toast when rename fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.renamePath.mockRejectedValue(new Error('name exists'));

    await expect(
      renameWithUndo('/dir/old.txt', 'new.txt', mocks.showToast, mocks.onRefresh)
    ).resolves.toBeNull();

    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Failed to rename: Name exists', {
      type: 'error',
    });
    expect(mocks.onRefresh).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('returns false and reports the first error when every move fails', async () => {
    mocks.moveToFolder.mockRejectedValue(new Error('read-only volume'));

    await expect(
      moveWithUndo([file('/src/a.txt')], '/dest', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(false);

    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Failed to move: This location is read-only', {
      type: 'error',
    });
    expect(mocks.onRefresh).not.toHaveBeenCalled();
  });

  it('returns false and reports the first error when every copy fails', async () => {
    mocks.copyPathToDir.mockRejectedValue(new Error('disk full'));

    await expect(
      copyWithUndo([file('/src/a.txt')], '/dest', mocks.showToast, mocks.onRefresh)
    ).resolves.toBe(false);

    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Failed to copy: Not enough disk space', {
      type: 'error',
    });
    expect(mocks.onRefresh).not.toHaveBeenCalled();
  });

  it('lets the partial-copy toast action remove completed copies', async () => {
    mocks.copyPathToDir.mockResolvedValueOnce('/dest/a.txt').mockRejectedValueOnce(new Error('io'));

    await expect(
      copyWithUndo(
        [file('/src/a.txt'), file('/src/b.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh
      )
    ).resolves.toBe(false);

    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Copied 1 item(s), but 1 failed'),
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' }),
        type: 'warning',
      })
    );

    mocks.fileExists.mockResolvedValue(true);
    await latestToastOptions().action?.onClick();

    expect(mocks.deletePath).toHaveBeenCalledWith('/dest/a.txt', true);
    expect(mocks.onRefresh).toHaveBeenCalled();
  });
});

describe('fileOperations conflict resolution', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        mock.mockReset();
      }
    }
    mocks.generateOperationId.mockReturnValue('op-test');
    mocks.joinPaths.mockImplementation((...parts: string[]) =>
      parts.filter(Boolean).join('/').replace(/\/+/g, '/')
    );
  });

  it('reports success when every conflicting copy is skipped', async () => {
    mocks.fileExists.mockResolvedValue(true);

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'skip',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.resetConflicts).toHaveBeenCalledWith('copy');
    expect(mocks.copyPathToDir).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('All files were skipped', { type: 'info' });
  });

  it('replaces conflicting copies before pushing an undo operation', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.remove.mockResolvedValue(undefined);
    mocks.copyPathToDir.mockResolvedValue('/dest/a.txt');

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'replace',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.remove).toHaveBeenCalledWith('/dest/a.txt', { recursive: true });
    expect(mocks.copyPathToDir).toHaveBeenCalledWith('/src/a.txt', '/dest');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'copy' }));
  });

  it('uses queued conflict decisions in ask mode', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.checkForConflict.mockResolvedValue({
      sourcePath: '/src/a.txt',
      targetPath: '/dest/a.txt',
    });
    mocks.queueConflict.mockResolvedValue('skip');

    await expect(
      moveWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'ask',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.resetConflicts).toHaveBeenCalledWith('move');
    expect(mocks.checkForConflict).toHaveBeenCalledWith('/src/a.txt', '/dest', false);
    expect(mocks.queueConflict).toHaveBeenCalledWith({
      sourcePath: '/src/a.txt',
      targetPath: '/dest/a.txt',
    });
    expect(mocks.moveToFolder).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('All files were skipped', { type: 'info' });
  });

  it('keeps both conflicting moves by renaming to a unique destination', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.uniquePath.mockResolvedValue('/dest/a (2).txt');
    mocks.rename.mockResolvedValue(undefined);

    await expect(
      moveWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'keepBoth',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.uniquePath).toHaveBeenCalledWith('/dest', 'a.txt');
    expect(mocks.rename).toHaveBeenCalledWith('/src/a.txt', '/dest/a (2).txt');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
    expect(mocks.clearDirSizeCache).toHaveBeenCalled();
  });

  it('treats a missing conflict record in ask mode as a replace copy', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.checkForConflict.mockResolvedValue(null);
    mocks.remove.mockResolvedValue(undefined);
    mocks.copyPathToDir.mockResolvedValue('/dest/a.txt');

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'ask',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.queueConflict).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith('/dest/a.txt', { recursive: true });
    expect(mocks.copyPathToDir).toHaveBeenCalledWith('/src/a.txt', '/dest');
  });

  it('continues move replacement even if deleting the existing target fails', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.remove.mockRejectedValue(new Error('locked'));
    mocks.moveToFolder.mockResolvedValue(undefined);

    await expect(
      moveWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'replace',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.remove).toHaveBeenCalledWith('/dest/a.txt', { recursive: true });
    expect(mocks.moveToFolder).toHaveBeenCalledWith('/src/a.txt', '/dest');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'move' }));
  });

  it('keeps both conflicting copies without deleting the existing target', async () => {
    mocks.fileExists.mockResolvedValue(true);
    mocks.copyPathToDir.mockResolvedValue('/dest/a copy.txt');

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/src/a.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'keepBoth',
        }
      )
    ).resolves.toBe(true);

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.copyPathToDir).toHaveBeenCalledWith('/src/a.txt', '/dest');
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'copy' }));
  });

  it('returns false when conflict-aware copy has successes and failures', async () => {
    mocks.fileExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.copyPathToDir.mockResolvedValueOnce('/dest/a.txt').mockRejectedValueOnce(new Error('io'));

    await expect(
      copyWithUndoAndConflictResolution(
        [file('/src/a.txt'), file('/src/b.txt'), file('/src/c.txt')],
        '/dest',
        mocks.showToast,
        mocks.onRefresh,
        {
          conflictResolution: 'skip',
        }
      )
    ).resolves.toBe(false);

    expect(mocks.copyPathToDir).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'copy' }));
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Copied 1 item(s), but 1 failed: c.txt',
      expect.objectContaining({ type: 'warning' })
    );
  });
});
