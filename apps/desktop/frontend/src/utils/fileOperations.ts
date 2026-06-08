/**
 * High-level file operations with undo/redo support.
 * These wrap the low-level fs utilities and push operations to the undo stack.
 */
import type { FileEntry } from '../store';
import type {
  DeleteOperation,
  RenameOperation,
  MoveOperation,
  CopyOperation,
  CreateOperation,
} from '../undoRedoStore';
import { useUndoRedoStore, generateOperationId } from '../undoRedoStore';
import {
  deletePath,
  renamePath,
  moveToFolder,
  copyPathToDir,
  createFolderIn,
  createNoteIn,
  joinPaths,
  fileExists,
  uniquePath,
} from './fs';
import { formatErrorMessage } from './errorMessages';
import { describeFileEntry, formatItemCount, summarizeFailedItems } from './fileOperationFormat';
import { writeFile as writeBinaryFile, mkdir, rename, stat, remove } from '@tauri-apps/plugin-fs';
import { basename, getParentPath } from './path';
import { clearDirSizeCache } from '../dirSizeCache';
import { ensureTrashDir as ensureGlobalTrashDir, isTrashPath, TRASH_FOLDER_NAME } from './trash';
import type { ConflictAction } from '../conflictResolutionStore';
import { useConflictResolutionStore, checkForConflict } from '../conflictResolutionStore';

// Callback type for showing toasts
export type ShowToastFn = (
  message: string,
  options?: {
    type?: 'info' | 'success' | 'warning' | 'error';
    action?: { label: string; onClick: () => void };
    duration?: number;
  }
) => void;

// Callback type for refreshing file list
export type RefreshFn = () => void | Promise<void>;

export interface DeleteOptions {
  /** If true, permanently delete without moving to trash */
  permanent?: boolean;
}

/**
 * Delete files/folders with undo support.
 * Moves items into a global trash folder (fallback per-directory) so they can be restored.
 * If permanent is true, items are deleted immediately without going to trash.
 */
export async function deleteWithUndo(
  files: FileEntry[],
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: DeleteOptions = {}
): Promise<boolean> {
  if (files.length === 0) return false;

  const toDescriptor = describeFileEntry;

  type DeleteBackup = {
    originalPath: string;
    trashPath: string;
    name: string;
    isDir: boolean;
  };

  const ensureLocalTrashDir = async (parentDir: string): Promise<string> => {
    const baseName = TRASH_FOLDER_NAME;
    for (let i = 0; i < 100; i++) {
      const suffix = i === 0 ? '' : `-${i}`;
      const candidate = joinPaths(parentDir, `${baseName}${suffix}`);
      if (await fileExists(candidate)) {
        try {
          const info = await stat(candidate);
          if (info.isDirectory) return candidate;
        } catch {}
        continue;
      }
      try {
        await mkdir(candidate);
        return candidate;
      } catch {
        // Retry with a new suffix if creation failed (exists or permission race).
      }
    }
    throw new Error('Unable to create trash directory');
  };

  const moveToTrash = async (file: FileEntry, trashDir: string | null): Promise<DeleteBackup> => {
    const name = file.name || basename(file.path) || file.path;
    const targetDir = trashDir ?? (await ensureLocalTrashDir(getParentPath(file.path)));
    const trashPath = await uniquePath(targetDir, name);
    await rename(file.path, trashPath);
    return {
      originalPath: file.path,
      trashPath,
      name,
      isDir: file.is_dir,
    };
  };

  try {
    const trashDir = options.permanent ? null : await ensureGlobalTrashDir();
    const trashableFiles: FileEntry[] = [];
    const permanentFiles: FileEntry[] = [];

    // If permanent delete is requested, all files go to permanent
    if (options.permanent) {
      permanentFiles.push(...files);
    } else {
      for (const file of files) {
        if (isTrashPath(file.path, trashDir)) {
          permanentFiles.push(file);
        } else {
          trashableFiles.push(file);
        }
      }
    }

    const trashableItems = trashableFiles.map(toDescriptor);
    const permanentItems = permanentFiles.map(toDescriptor);

    const backups: DeleteBackup[] = [];
    if (trashableFiles.length > 0) {
      try {
        for (const file of trashableFiles) {
          backups.push(await moveToTrash(file, trashDir));
        }
      } catch (error) {
        for (const backup of backups.slice().reverse()) {
          try {
            await rename(backup.trashPath, backup.originalPath);
          } catch {}
        }
        throw error;
      }
    }

    let permanentDeleteError: unknown = null;
    if (permanentFiles.length > 0) {
      try {
        for (const file of permanentFiles) {
          await deletePath(file.path, true);
        }
      } catch (error) {
        permanentDeleteError = error;
      }
    }

    // Create operation for undo/redo
    if (backups.length > 0) {
      const operation: DeleteOperation = {
        id: generateOperationId(),
        type: 'delete',
        timestamp: Date.now(),
        description:
          trashableItems.length === 1
            ? `Delete "${trashableItems[0].name}"`
            : `Delete ${trashableItems.length} items`,
        deletedItems: trashableItems,
        backups,
        undo: async () => {
          try {
            const restoreOrder = [...(operation.backups || [])].sort(
              (a, b) => a.originalPath.length - b.originalPath.length
            );
            for (const backup of restoreOrder) {
              if (await fileExists(backup.trashPath)) {
                await rename(backup.trashPath, backup.originalPath);
              }
            }
            clearDirSizeCache();
            await onRefresh();
            const itemText = formatItemCount(trashableItems.length, trashableItems[0].name);
            showToast(`Restored ${itemText}`, {
              type: 'info',
            });
            return true;
          } catch (e) {
            showToast(`Failed to restore items: ${formatErrorMessage(e)}`, {
              type: 'error',
            });
            return false;
          }
        },
        redo: async () => {
          try {
            const redoBackups = operation.backups || [];
            for (const backup of redoBackups) {
              if (await fileExists(backup.originalPath)) {
                const backupDir = getParentPath(backup.trashPath);
                let targetPath = backup.trashPath;
                if (await fileExists(targetPath)) {
                  targetPath = await uniquePath(backupDir, basename(targetPath));
                  backup.trashPath = targetPath;
                }
                await rename(backup.originalPath, targetPath);
              }
            }
            clearDirSizeCache();
            await onRefresh();
            const itemText = formatItemCount(trashableItems.length, trashableItems[0].name);
            showToast(`Deleted ${itemText}`, {
              type: 'info',
            });
            return true;
          } catch (e) {
            showToast(`Failed to redo delete: ${formatErrorMessage(e)}`, {
              type: 'error',
            });
            return false;
          }
        },
      };

      useUndoRedoStore.getState().push(operation);

      // Show success toast with undo action
      const itemText = formatItemCount(trashableItems.length, trashableItems[0].name);
      showToast(`Deleted ${itemText}`, {
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            useUndoRedoStore.getState().undo();
          },
        },
      });
    }

    if (permanentItems.length > 0) {
      if (permanentDeleteError) {
        showToast(
          `Failed to delete items from Trash: ${formatErrorMessage(permanentDeleteError)}`,
          { type: 'error' }
        );
      } else {
        const itemText = formatItemCount(permanentItems.length, permanentItems[0].name);
        showToast(`Permanently deleted ${itemText}`, { type: 'warning' });
      }
    }

    clearDirSizeCache();
    await onRefresh();
    return permanentDeleteError ? false : true;
  } catch (error) {
    console.error('Delete failed:', error);
    try {
      for (const file of files) {
        await deletePath(file.path, true);
      }
      clearDirSizeCache();
      await onRefresh();
      showToast('Trash unavailable, items were deleted permanently', { type: 'warning' });
      return true;
    } catch {
      showToast(`Failed to delete: ${formatErrorMessage(error)}`, {
        type: 'error',
      });
    }
    return false;
  }
}

/**
 * Rename a file/folder with undo support.
 */
export async function renameWithUndo(
  sourcePath: string,
  newName: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn
): Promise<string | null> {
  const oldName = sourcePath.split(/[/\\]/).pop() || sourcePath;

  if (newName === oldName) {
    return sourcePath; // No change needed
  }

  try {
    const newPath = await renamePath(sourcePath, newName);

    const operation: RenameOperation = {
      id: generateOperationId(),
      type: 'rename',
      timestamp: Date.now(),
      description: `Rename "${oldName}" to "${newName}"`,
      oldPath: sourcePath,
      newPath,
      oldName,
      newName,
      undo: async () => {
        try {
          await renamePath(newPath, oldName);
          await onRefresh();
          showToast(`Undid rename: "${newName}" → "${oldName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to undo rename: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
      redo: async () => {
        try {
          await renamePath(sourcePath, newName);
          await onRefresh();
          showToast(`Redid rename: "${oldName}" → "${newName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to redo rename: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
    };

    useUndoRedoStore.getState().push(operation);

    showToast(`Renamed to "${newName}"`, {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: () => {
          useUndoRedoStore.getState().undo();
        },
      },
    });

    await onRefresh();
    return newPath;
  } catch (error) {
    console.error('Rename failed:', error);
    showToast(`Failed to rename: ${formatErrorMessage(error)}`, {
      type: 'error',
    });
    return null;
  }
}

/**
 * Move files/folders with undo support and partial failure rollback.
 */
export async function moveWithUndo(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn
): Promise<boolean> {
  if (files.length === 0) return false;

  const moveItems: MoveOperation['items'] = [];
  const completedMoves: Array<{ sourcePath: string; destPath: string; name: string }> = [];
  const failedMoves: Array<{ name: string; error: string }> = [];

  // Process each file, tracking successes and failures
  for (const file of files) {
    const name = describeFileEntry(file).name;
    const destPath = joinPaths(targetDir, name);

    try {
      await moveToFolder(file.path, targetDir);
      completedMoves.push({ sourcePath: file.path, destPath, name });
      moveItems.push({ sourcePath: file.path, destPath, name });
    } catch (error) {
      failedMoves.push({ name, error: formatErrorMessage(error) });
    }
  }

  // If all failed and nothing succeeded, return failure
  if (completedMoves.length === 0) {
    const firstError = failedMoves[0]?.error || 'Unknown error';
    showToast(`Failed to move: ${firstError}`, { type: 'error' });
    return false;
  }

  // If some failed but some succeeded, offer rollback or continue
  if (failedMoves.length > 0) {
    const rollbackCompletedMoves = async () => {
      let rollbackSuccessCount = 0;
      for (const item of completedMoves) {
        try {
          const sourceDir = getParentPath(item.sourcePath);
          await moveToFolder(item.destPath, sourceDir);
          rollbackSuccessCount++;
        } catch {
          // Rollback failed for this item, continue with others
        }
      }
      await onRefresh();
      if (rollbackSuccessCount === completedMoves.length) {
        showToast(`Rolled back ${rollbackSuccessCount} moved item(s)`, { type: 'info' });
      } else {
        showToast(`Partially rolled back (${rollbackSuccessCount}/${completedMoves.length})`, {
          type: 'warning',
        });
      }
    };

    // Show warning with option to undo the partial move
    const failedSummary = summarizeFailedItems(failedMoves);
    showToast(
      `Moved ${completedMoves.length} item(s), but ${failedMoves.length} failed: ${failedSummary}`,
      {
        type: 'warning',
        action: {
          label: 'Undo',
          onClick: rollbackCompletedMoves,
        },
        duration: 8000, // Give more time to see the undo option
      }
    );

    // Still create the undo operation for the items that did succeed
    if (completedMoves.length > 0) {
      const operation: MoveOperation = {
        id: generateOperationId(),
        type: 'move',
        timestamp: Date.now(),
        description: `Move ${completedMoves.length} item(s) (partial)`,
        items: moveItems,
        undo: async () => {
          try {
            for (const item of moveItems) {
              const sourceDir = getParentPath(item.sourcePath);
              await moveToFolder(item.destPath, sourceDir);
            }
            await onRefresh();
            showToast(`Undid move of ${moveItems.length} item(s)`, { type: 'info' });
            return true;
          } catch (e) {
            showToast(`Failed to undo move: ${formatErrorMessage(e)}`, { type: 'error' });
            return false;
          }
        },
        redo: async () => {
          try {
            for (const item of moveItems) {
              await moveToFolder(item.sourcePath, targetDir);
            }
            await onRefresh();
            showToast(`Redid move of ${moveItems.length} item(s)`, { type: 'info' });
            return true;
          } catch (e) {
            showToast(`Failed to redo move: ${formatErrorMessage(e)}`, { type: 'error' });
            return false;
          }
        },
      };
      useUndoRedoStore.getState().push(operation);
    }

    await onRefresh();
    return false; // Partial success is considered a failure
  }

  // All succeeded - create the undo operation
  const operation: MoveOperation = {
    id: generateOperationId(),
    type: 'move',
    timestamp: Date.now(),
    description: files.length === 1 ? `Move "${moveItems[0].name}"` : `Move ${files.length} items`,
    items: moveItems,
    undo: async () => {
      try {
        for (const item of moveItems) {
          const sourceDir = getParentPath(item.sourcePath);
          await moveToFolder(item.destPath, sourceDir);
        }
        await onRefresh();
        showToast(`Undid move of ${moveItems.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to undo move: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        for (const item of moveItems) {
          await moveToFolder(item.sourcePath, targetDir);
        }
        await onRefresh();
        showToast(`Redid move of ${moveItems.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to redo move: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
  };

  useUndoRedoStore.getState().push(operation);

  const itemText = formatItemCount(files.length, moveItems[0].name);
  showToast(`Moved ${itemText}`, {
    type: 'success',
    action: {
      label: 'Undo',
      onClick: () => {
        useUndoRedoStore.getState().undo();
      },
    },
  });

  await onRefresh();
  return true;
}

/**
 * Copy files/folders with undo support and partial failure rollback.
 * Undo will delete the created copies.
 */
export async function copyWithUndo(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn
): Promise<boolean> {
  if (files.length === 0) return false;

  const createdPaths: string[] = [];
  const sourceItems: Array<{ path: string; name: string }> = [];
  const failedCopies: Array<{ name: string; error: string }> = [];

  // Process each file, tracking successes and failures
  for (const file of files) {
    const name = describeFileEntry(file).name;

    try {
      const destPath = await copyPathToDir(file.path, targetDir);
      createdPaths.push(destPath);
      sourceItems.push({ path: file.path, name });
    } catch (error) {
      failedCopies.push({ name, error: formatErrorMessage(error) });
    }
  }

  // If all failed and nothing succeeded, return failure
  if (createdPaths.length === 0) {
    const firstError = failedCopies[0]?.error || 'Unknown error';
    showToast(`Failed to copy: ${firstError}`, { type: 'error' });
    return false;
  }

  // If some failed but some succeeded, offer rollback or continue
  if (failedCopies.length > 0) {
    const rollbackCompletedCopies = async () => {
      let rollbackSuccessCount = 0;
      for (const path of createdPaths) {
        try {
          if (await fileExists(path)) {
            await deletePath(path, true);
            rollbackSuccessCount++;
          }
        } catch {
          // Rollback failed for this item, continue with others
        }
      }
      await onRefresh();
      if (rollbackSuccessCount === createdPaths.length) {
        showToast(`Removed ${rollbackSuccessCount} copied item(s)`, { type: 'info' });
      } else {
        showToast(`Partially cleaned up (${rollbackSuccessCount}/${createdPaths.length})`, {
          type: 'warning',
        });
      }
    };

    // Show warning with option to undo the partial copy
    const failedSummary = summarizeFailedItems(failedCopies);
    showToast(
      `Copied ${createdPaths.length} item(s), but ${failedCopies.length} failed: ${failedSummary}`,
      {
        type: 'warning',
        action: {
          label: 'Undo',
          onClick: rollbackCompletedCopies,
        },
        duration: 8000,
      }
    );

    // Still create the undo operation for the items that did succeed
    if (createdPaths.length > 0) {
      const operation: CopyOperation = {
        id: generateOperationId(),
        type: 'copy',
        timestamp: Date.now(),
        description: `Copy ${createdPaths.length} item(s) (partial)`,
        createdPaths,
        sourceItems,
        undo: async () => {
          try {
            for (const path of createdPaths) {
              if (await fileExists(path)) {
                await deletePath(path, true);
              }
            }
            await onRefresh();
            showToast(`Undid copy of ${createdPaths.length} item(s)`, { type: 'info' });
            return true;
          } catch (e) {
            showToast(`Failed to undo copy: ${formatErrorMessage(e)}`, { type: 'error' });
            return false;
          }
        },
        redo: async () => {
          try {
            const newPaths: string[] = [];
            for (const item of sourceItems) {
              if (await fileExists(item.path)) {
                const destPath = await copyPathToDir(item.path, targetDir);
                newPaths.push(destPath);
              }
            }
            operation.createdPaths = newPaths;
            await onRefresh();
            showToast(`Redid copy of ${newPaths.length} item(s)`, { type: 'info' });
            return true;
          } catch (e) {
            showToast(`Failed to redo copy: ${formatErrorMessage(e)}`, { type: 'error' });
            return false;
          }
        },
      };
      useUndoRedoStore.getState().push(operation);
    }

    await onRefresh();
    return false; // Partial success is considered a failure
  }

  // All succeeded - create the undo operation
  const operation: CopyOperation = {
    id: generateOperationId(),
    type: 'copy',
    timestamp: Date.now(),
    description:
      files.length === 1 ? `Copy "${sourceItems[0].name}"` : `Copy ${files.length} items`,
    createdPaths,
    sourceItems,
    undo: async () => {
      try {
        for (const path of createdPaths) {
          if (await fileExists(path)) {
            await deletePath(path, true);
          }
        }
        await onRefresh();
        showToast(`Undid copy of ${createdPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to undo copy: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        const newPaths: string[] = [];
        for (const item of sourceItems) {
          if (await fileExists(item.path)) {
            const destPath = await copyPathToDir(item.path, targetDir);
            newPaths.push(destPath);
          }
        }
        operation.createdPaths = newPaths;
        await onRefresh();
        showToast(`Redid copy of ${newPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to redo copy: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
  };

  useUndoRedoStore.getState().push(operation);

  const itemText = formatItemCount(files.length, sourceItems[0].name);
  showToast(`Copied ${itemText}`, {
    type: 'success',
    action: {
      label: 'Undo',
      onClick: () => {
        useUndoRedoStore.getState().undo();
      },
    },
  });

  await onRefresh();
  return true;
}

/**
 * Create a new folder with undo support.
 */
export async function createFolderWithUndo(
  parentDir: string,
  name: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn
): Promise<string | null> {
  try {
    const createdPath = await createFolderIn(parentDir, name);
    const actualName = createdPath.split(/[/\\]/).pop() || name;

    const operation: CreateOperation = {
      id: generateOperationId(),
      type: 'create',
      timestamp: Date.now(),
      description: `Create folder "${actualName}"`,
      createdPath,
      itemType: 'folder',
      name: actualName,
      undo: async () => {
        try {
          if (await fileExists(createdPath)) {
            await deletePath(createdPath, true);
          }
          await onRefresh();
          showToast(`Undid create folder "${actualName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to undo create folder: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
      redo: async () => {
        try {
          if (!(await fileExists(createdPath))) {
            await mkdir(createdPath);
          }
          await onRefresh();
          showToast(`Redid create folder "${actualName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to redo create folder: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
    };

    useUndoRedoStore.getState().push(operation);

    showToast(`Created folder "${actualName}"`, {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: () => {
          useUndoRedoStore.getState().undo();
        },
      },
    });

    await onRefresh();
    return createdPath;
  } catch (error) {
    console.error('Create folder failed:', error);
    showToast(`Failed to create folder: ${formatErrorMessage(error)}`, {
      type: 'error',
    });
    return null;
  }
}

/**
 * Create a new note/file with undo support.
 */
export async function createFileWithUndo(
  parentDir: string,
  name: string,
  content: string = '',
  showToast: ShowToastFn,
  onRefresh: RefreshFn
): Promise<string | null> {
  try {
    const createdPath = await createNoteIn(parentDir, name);
    const actualName = createdPath.split(/[/\\]/).pop() || name;

    const operation: CreateOperation = {
      id: generateOperationId(),
      type: 'create',
      timestamp: Date.now(),
      description: `Create file "${actualName}"`,
      createdPath,
      itemType: 'file',
      name: actualName,
      content,
      undo: async () => {
        try {
          if (await fileExists(createdPath)) {
            await deletePath(createdPath, false);
          }
          await onRefresh();
          showToast(`Undid create file "${actualName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to undo create file: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
      redo: async () => {
        try {
          if (!(await fileExists(createdPath))) {
            const textEncoder = new TextEncoder();
            await writeBinaryFile(createdPath, textEncoder.encode(content || '# New Note\n'));
          }
          await onRefresh();
          showToast(`Redid create file "${actualName}"`, { type: 'info' });
          return true;
        } catch (e) {
          showToast(`Failed to redo create file: ${formatErrorMessage(e)}`, {
            type: 'error',
          });
          return false;
        }
      },
    };

    useUndoRedoStore.getState().push(operation);

    showToast(`Created file "${actualName}"`, {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: () => {
          useUndoRedoStore.getState().undo();
        },
      },
    });

    await onRefresh();
    return createdPath;
  } catch (error) {
    console.error('Create file failed:', error);
    showToast(`Failed to create file: ${formatErrorMessage(error)}`, {
      type: 'error',
    });
    return null;
  }
}

/**
 * Options for copy/move operations with conflict resolution.
 */
export interface ConflictResolutionOptions {
  /** How to handle conflicts: 'ask' prompts user, others auto-resolve */
  conflictResolution: 'skip' | 'replace' | 'keepBoth' | 'ask';
}

/**
 * Copy a single file with conflict handling.
 * Returns the destination path if successful, null if skipped.
 */
async function copySingleFileWithConflict(
  sourcePath: string,
  targetDir: string,
  isDir: boolean,
  options: ConflictResolutionOptions
): Promise<string | null> {
  const name = basename(sourcePath);
  const destPath = joinPaths(targetDir, name);

  // Check if destination exists
  const destExists = await fileExists(destPath);

  if (destExists) {
    let action: ConflictAction;

    if (options.conflictResolution === 'ask') {
      // Check for conflict and queue it for resolution
      const conflictInfo = await checkForConflict(sourcePath, targetDir, isDir);
      if (conflictInfo) {
        action = await useConflictResolutionStore.getState().queueConflict(conflictInfo);
      } else {
        action = 'replace'; // No conflict, proceed
      }
    } else {
      action = options.conflictResolution as ConflictAction;
    }

    switch (action) {
      case 'skip':
        return null;
      case 'replace':
        // Delete existing and copy
        try {
          await remove(destPath, { recursive: true });
        } catch {
          // If delete fails, try to copy anyway
        }
        break;
      case 'keepBoth':
        // Use unique path (copyPathToDir already handles this)
        break;
    }
  }

  // Perform the copy
  return await copyPathToDir(sourcePath, targetDir);
}

/**
 * Move a single file with conflict handling.
 * Returns true if successful, false if skipped.
 */
async function moveSingleFileWithConflict(
  sourcePath: string,
  targetDir: string,
  isDir: boolean,
  options: ConflictResolutionOptions
): Promise<{ success: boolean; destPath?: string }> {
  const name = basename(sourcePath);
  const destPath = joinPaths(targetDir, name);

  // Check if destination exists
  const destExists = await fileExists(destPath);

  if (destExists) {
    let action: ConflictAction;

    if (options.conflictResolution === 'ask') {
      const conflictInfo = await checkForConflict(sourcePath, targetDir, isDir);
      if (conflictInfo) {
        action = await useConflictResolutionStore.getState().queueConflict(conflictInfo);
      } else {
        action = 'replace';
      }
    } else {
      action = options.conflictResolution as ConflictAction;
    }

    switch (action) {
      case 'skip':
        return { success: false };
      case 'replace':
        // Delete existing first
        try {
          await remove(destPath, { recursive: true });
        } catch {
          // If delete fails, try to move anyway (will likely fail too)
        }
        await moveToFolder(sourcePath, targetDir);
        return { success: true, destPath };
      case 'keepBoth':
        // Generate unique name
        const uniqueDestPath = await uniquePath(targetDir, name);
        await rename(sourcePath, uniqueDestPath);
        return { success: true, destPath: uniqueDestPath };
    }
  }

  // No conflict, just move
  await moveToFolder(sourcePath, targetDir);
  return { success: true, destPath };
}

/**
 * Copy files/folders with undo support and conflict resolution.
 * Supports 'ask' mode which will prompt user for each conflict.
 */
export async function copyWithUndoAndConflictResolution(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: ConflictResolutionOptions = { conflictResolution: 'ask' }
): Promise<boolean> {
  if (files.length === 0) return false;

  // Reset conflict resolution state
  useConflictResolutionStore.getState().reset('copy');

  const createdPaths: string[] = [];
  const sourceItems: Array<{ path: string; name: string }> = [];
  const failedCopies: Array<{ name: string; error: string }> = [];
  const skippedItems: string[] = [];

  // Process each file
  for (const file of files) {
    const name = describeFileEntry(file).name;

    try {
      const destPath = await copySingleFileWithConflict(file.path, targetDir, file.is_dir, options);

      if (destPath) {
        createdPaths.push(destPath);
        sourceItems.push({ path: file.path, name });
      } else {
        skippedItems.push(name);
      }
    } catch (error) {
      failedCopies.push({ name, error: formatErrorMessage(error) });
    }
  }

  // If all skipped or failed
  if (createdPaths.length === 0) {
    if (skippedItems.length === files.length) {
      showToast('All files were skipped', { type: 'info' });
      return true;
    }
    const firstError = failedCopies[0]?.error || 'Unknown error';
    showToast(`Failed to copy: ${firstError}`, { type: 'error' });
    return false;
  }

  // Show appropriate toast based on results
  let toastMessage: string;
  let toastType: 'success' | 'warning' | 'info' = 'success';

  if (failedCopies.length > 0) {
    const failedSummary = summarizeFailedItems(failedCopies);
    toastMessage = `Copied ${createdPaths.length} item(s), but ${failedCopies.length} failed: ${failedSummary}`;
    toastType = 'warning';
  } else if (skippedItems.length > 0) {
    toastMessage = `Copied ${createdPaths.length} item(s), skipped ${skippedItems.length}`;
    toastType = 'info';
  } else {
    const itemText = formatItemCount(files.length, sourceItems[0].name);
    toastMessage = `Copied ${itemText}`;
  }

  // Create undo operation
  const operation: CopyOperation = {
    id: generateOperationId(),
    type: 'copy',
    timestamp: Date.now(),
    description:
      createdPaths.length === 1
        ? `Copy "${sourceItems[0]?.name || 'item'}"`
        : `Copy ${createdPaths.length} items`,
    createdPaths,
    sourceItems,
    undo: async () => {
      try {
        for (const path of createdPaths) {
          if (await fileExists(path)) {
            await deletePath(path, true);
          }
        }
        await onRefresh();
        showToast(`Undid copy of ${createdPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to undo copy: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        const newPaths: string[] = [];
        for (const item of sourceItems) {
          if (await fileExists(item.path)) {
            const destPath = await copyPathToDir(item.path, targetDir);
            newPaths.push(destPath);
          }
        }
        operation.createdPaths = newPaths;
        await onRefresh();
        showToast(`Redid copy of ${newPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to redo copy: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
  };

  useUndoRedoStore.getState().push(operation);

  showToast(toastMessage, {
    type: toastType,
    action: {
      label: 'Undo',
      onClick: () => {
        useUndoRedoStore.getState().undo();
      },
    },
  });

  await onRefresh();
  return failedCopies.length === 0;
}

/**
 * Move files/folders with undo support and conflict resolution.
 * Supports 'ask' mode which will prompt user for each conflict.
 */
export async function moveWithUndoAndConflictResolution(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: ConflictResolutionOptions = { conflictResolution: 'ask' }
): Promise<boolean> {
  if (files.length === 0) return false;

  // Reset conflict resolution state
  useConflictResolutionStore.getState().reset('move');

  const moveItems: MoveOperation['items'] = [];
  const failedMoves: Array<{ name: string; error: string }> = [];
  const skippedItems: string[] = [];

  // Process each file
  for (const file of files) {
    const name = describeFileEntry(file).name;

    try {
      const result = await moveSingleFileWithConflict(file.path, targetDir, file.is_dir, options);

      if (result.success && result.destPath) {
        moveItems.push({
          sourcePath: file.path,
          destPath: result.destPath,
          name,
        });
      } else {
        skippedItems.push(name);
      }
    } catch (error) {
      failedMoves.push({ name, error: formatErrorMessage(error) });
    }
  }

  // If all skipped or failed
  if (moveItems.length === 0) {
    if (skippedItems.length === files.length) {
      showToast('All files were skipped', { type: 'info' });
      return true;
    }
    const firstError = failedMoves[0]?.error || 'Unknown error';
    showToast(`Failed to move: ${firstError}`, { type: 'error' });
    return false;
  }

  // Show appropriate toast based on results
  let toastMessage: string;
  let toastType: 'success' | 'warning' | 'info' = 'success';

  if (failedMoves.length > 0) {
    const failedSummary = summarizeFailedItems(failedMoves);
    toastMessage = `Moved ${moveItems.length} item(s), but ${failedMoves.length} failed: ${failedSummary}`;
    toastType = 'warning';
  } else if (skippedItems.length > 0) {
    toastMessage = `Moved ${moveItems.length} item(s), skipped ${skippedItems.length}`;
    toastType = 'info';
  } else {
    const itemText = formatItemCount(files.length, moveItems[0].name);
    toastMessage = `Moved ${itemText}`;
  }

  // Create undo operation
  const operation: MoveOperation = {
    id: generateOperationId(),
    type: 'move',
    timestamp: Date.now(),
    description:
      moveItems.length === 1 ? `Move "${moveItems[0].name}"` : `Move ${moveItems.length} items`,
    items: moveItems,
    undo: async () => {
      try {
        for (const item of moveItems) {
          const sourceDir = getParentPath(item.sourcePath);
          await moveToFolder(item.destPath, sourceDir);
        }
        await onRefresh();
        showToast(`Undid move of ${moveItems.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to undo move: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        for (const item of moveItems) {
          await moveToFolder(item.sourcePath, targetDir);
        }
        await onRefresh();
        showToast(`Redid move of ${moveItems.length} item(s)`, { type: 'info' });
        return true;
      } catch (e) {
        showToast(`Failed to redo move: ${formatErrorMessage(e)}`, { type: 'error' });
        return false;
      }
    },
  };

  useUndoRedoStore.getState().push(operation);

  showToast(toastMessage, {
    type: toastType,
    action: {
      label: 'Undo',
      onClick: () => {
        useUndoRedoStore.getState().undo();
      },
    },
  });

  clearDirSizeCache();
  await onRefresh();
  return failedMoves.length === 0;
}
