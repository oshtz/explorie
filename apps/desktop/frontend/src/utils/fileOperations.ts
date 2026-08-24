/**
 * High-level file mutations.
 *
 * Copy, move, and Trash are deliberately routed through the constrained native
 * job boundary so filesystem work never runs inside the webview.
 */
import type { FileEntry } from '../store';
import type { CopyOperation, MoveOperation } from '../undoRedoStore';
import { generateOperationId, useUndoRedoStore } from '../undoRedoStore';
import { clearDirSizeCache } from '../dirSizeCache';
import type { ConflictAction, ConflictInfo } from '../conflictResolutionStore';
import { checkForConflict, useConflictResolutionStore } from '../conflictResolutionStore';
import { deletePath } from './fs';
import { formatErrorMessage } from './errorMessages';
import { describeFileEntry, formatItemCount, summarizeFailedItems } from './fileOperationFormat';
import { basename, getParentPath, joinPaths } from './path';
import {
  runNativeFileOperation,
  type NativeConflictPolicy,
  type NativeFileOperationResult,
} from './nativeFileOperations';

export type ShowToastFn = (
  message: string,
  options?: {
    type?: 'info' | 'success' | 'warning' | 'error';
    action?: { label: string; onClick: () => void };
    duration?: number;
  }
) => void;

export type RefreshFn = () => void | Promise<void>;

export interface DeleteOptions {
  /** Permanently delete only when the user explicitly selected that action. */
  permanent?: boolean;
}

export interface ConflictResolutionOptions {
  conflictResolution: 'skip' | 'replace' | 'keepBoth' | 'ask';
}

function presentationItem(file: FileEntry) {
  const descriptor = describeFileEntry(file);
  return {
    sourcePath: file.path,
    size: file.size ?? 0,
    name: descriptor.name,
    isDir: file.is_dir,
  };
}

function presentationPolicy(policy: NativeConflictPolicy): 'replace' | 'rename' {
  return policy === 'replace' ? 'replace' : 'rename';
}

async function resolveConflictPolicy(
  file: FileEntry,
  targetDir: string,
  options: ConflictResolutionOptions,
  duplicateOf?: FileEntry
): Promise<NativeConflictPolicy | null> {
  const conflict =
    (await checkForConflict(file.path, targetDir, file.is_dir)) ??
    (duplicateOf ? createDuplicateConflict(file, duplicateOf, targetDir) : null);
  if (!conflict) return 'error';

  let action: ConflictAction;
  if (options.conflictResolution === 'ask') {
    action = await useConflictResolutionStore.getState().queueConflict(conflict);
  } else {
    action = options.conflictResolution;
  }

  if (action === 'skip') return null;
  // A batch cannot replace a target reserved by another selected source. Keep
  // both sources without allowing native target resolution to reject the job.
  if (duplicateOf) return 'rename';
  return action === 'replace' ? 'replace' : 'rename';
}

function createDuplicateConflict(
  file: FileEntry,
  duplicateOf: FileEntry,
  targetDir: string
): ConflictInfo {
  const name = basename(file.path);
  return {
    sourcePath: file.path,
    sourceName: name,
    sourceSize: file.size,
    sourceIsDir: file.is_dir,
    destPath: joinPaths(targetDir, name),
    destName: name,
    destSize: duplicateOf.size,
    destIsDir: duplicateOf.is_dir,
  };
}

function batchTargetKey(file: FileEntry): string {
  // Windows and the default macOS filesystem treat target names as folded.
  return basename(file.path).toLocaleLowerCase();
}

async function runOne(
  kind: 'copy' | 'move',
  file: FileEntry,
  targetDir: string,
  policy: NativeConflictPolicy
): Promise<NativeFileOperationResult> {
  return runNativeFileOperation(
    {
      kind,
      sources: [file.path],
      destination: targetDir,
      conflictPolicy: policy,
    },
    {
      type: kind,
      items: [presentationItem(file)],
      destinationPath: targetDir,
      conflictResolution: presentationPolicy(policy),
    }
  );
}

async function runBatch(
  kind: 'copy' | 'move',
  files: FileEntry[],
  targetDir: string,
  policies: NativeConflictPolicy[]
): Promise<NativeFileOperationResult> {
  const distinctConflictPolicies = [...new Set(policies.filter((policy) => policy !== 'error'))];
  const displayPolicy =
    distinctConflictPolicies.length === 1
      ? presentationPolicy(distinctConflictPolicies[0])
      : distinctConflictPolicies.length > 1
        ? 'ask'
        : presentationPolicy('error');

  return runNativeFileOperation(
    {
      kind,
      sources: files.map((file) => file.path),
      destination: targetDir,
      conflictPolicy: policies.length === 1 ? policies[0] : 'error',
      ...(files.length > 1 ? { conflictPolicies: policies } : {}),
    },
    {
      type: kind,
      items: files.map(presentationItem),
      destinationPath: targetDir,
      conflictResolution: displayPolicy,
    }
  );
}

async function refreshAfterMutation(onRefresh: RefreshFn): Promise<void> {
  clearDirSizeCache();
  await onRefresh();
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Move items to the operating system Trash. A Trash failure is terminal and
 * never falls back to permanent deletion.
 */
export async function deleteWithUndo(
  files: FileEntry[],
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: DeleteOptions = {}
): Promise<boolean> {
  if (files.length === 0) return false;

  const descriptors = files.map(describeFileEntry);
  const itemText = formatItemCount(files.length, descriptors[0].name);

  if (options.permanent) {
    try {
      for (const file of files) {
        await deletePath(file.path, true);
      }
      await refreshAfterMutation(onRefresh);
      showToast(`Permanently deleted ${itemText}`, { type: 'warning' });
      return true;
    } catch (error) {
      showToast(`Failed to permanently delete items: ${formatErrorMessage(error)}`, {
        type: 'error',
      });
      return false;
    }
  }

  if (files.length > 1) {
    showToast(
      'Moving multiple items to Trash is temporarily disabled to guarantee failure-safe behavior. Move one item at a time.',
      { type: 'warning' }
    );
    return false;
  }

  try {
    await runNativeFileOperation(
      {
        kind: 'trash',
        sources: files.map((file) => file.path),
        destination: null,
        conflictPolicy: 'error',
      },
      {
        type: 'delete',
        items: files.map(presentationItem),
        conflictResolution: 'rename',
      }
    );
    await refreshAfterMutation(onRefresh);
    showToast(`Moved ${itemText} to Trash`, { type: 'success' });
    return true;
  } catch (error) {
    showToast(`Failed to move items to Trash: ${formatErrorMessage(error)}`, {
      type: 'error',
    });
    return false;
  }
}

export async function copyWithUndoAndConflictResolution(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: ConflictResolutionOptions = { conflictResolution: 'ask' }
): Promise<boolean> {
  if (files.length === 0) return false;
  useConflictResolutionStore.getState().reset('copy');

  const createdPaths: string[] = [];
  const sourceItems: CopyOperation['sourceItems'] = [];
  const completedFiles: FileEntry[] = [];
  const completedPolicies: NativeConflictPolicy[] = [];
  const pendingFiles: FileEntry[] = [];
  const pendingPolicies: NativeConflictPolicy[] = [];
  const pendingByTarget = new Map<string, FileEntry>();
  const failed: Array<{ name: string; error: string }> = [];
  const skipped: string[] = [];
  let cancelled = false;

  for (const file of files) {
    const name = describeFileEntry(file).name;
    try {
      const duplicateOf = pendingByTarget.get(batchTargetKey(file));
      const policy = await resolveConflictPolicy(file, targetDir, options, duplicateOf);
      if (!policy) {
        skipped.push(name);
        continue;
      }
      pendingFiles.push(file);
      pendingPolicies.push(policy);
      pendingByTarget.set(batchTargetKey(file), file);
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
        break;
      }
      failed.push({ name, error: formatErrorMessage(error) });
    }
  }

  if (!cancelled && pendingFiles.length > 0) {
    try {
      const result = await runBatch('copy', pendingFiles, targetDir, pendingPolicies);
      if (result.targets.length !== pendingFiles.length) {
        throw new Error('Native copy completed without all destination paths');
      }
      for (let index = 0; index < pendingFiles.length; index++) {
        const file = pendingFiles[index];
        createdPaths.push(result.targets[index]);
        sourceItems.push({ path: file.path, name: describeFileEntry(file).name });
        completedFiles.push(file);
        completedPolicies.push(pendingPolicies[index]);
      }
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
      } else {
        failed.push({
          name: formatItemCount(pendingFiles.length, describeFileEntry(pendingFiles[0]).name),
          error: formatErrorMessage(error),
        });
      }
    }
  }

  if (createdPaths.length === 0) {
    if (cancelled) {
      showToast('Copy cancelled', { type: 'warning' });
      return false;
    }
    if (skipped.length === files.length) {
      showToast('All files were skipped', { type: 'info' });
      return true;
    }
    showToast(`Failed to copy: ${failed[0]?.error || 'Unknown error'}`, { type: 'error' });
    return false;
  }

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
        await runNativeFileOperation(
          {
            kind: 'trash',
            sources: [...operation.createdPaths],
            destination: null,
            conflictPolicy: 'error',
          },
          {
            type: 'delete',
            items: operation.createdPaths.map((path, index) => ({
              sourcePath: path,
              size: completedFiles[index]?.size ?? 0,
              name: sourceItems[index]?.name || path,
              isDir: completedFiles[index]?.is_dir ?? false,
            })),
            conflictResolution: 'rename',
          }
        );
        await refreshAfterMutation(onRefresh);
        showToast(`Undid copy of ${operation.createdPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (error) {
        showToast(`Failed to undo copy: ${formatErrorMessage(error)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        const newPaths: string[] = [];
        for (let index = 0; index < completedFiles.length; index++) {
          const file = completedFiles[index];
          const result = await runOne('copy', file, targetDir, completedPolicies[index]);
          const target = result.targets[0];
          if (!target) throw new Error('Native copy completed without a destination path');
          newPaths.push(target);
        }
        operation.createdPaths = newPaths;
        await refreshAfterMutation(onRefresh);
        showToast(`Redid copy of ${newPaths.length} item(s)`, { type: 'info' });
        return true;
      } catch (error) {
        showToast(`Failed to redo copy: ${formatErrorMessage(error)}`, { type: 'error' });
        return false;
      }
    },
  };
  const canUndo = !completedPolicies.includes('replace');
  if (canUndo) useUndoRedoStore.getState().push(operation);

  let message: string;
  let type: 'success' | 'warning' | 'info' = 'success';
  if (cancelled) {
    message = `Copied ${createdPaths.length} item(s) before cancellation`;
    type = 'warning';
  } else if (failed.length > 0) {
    message = `Copied ${createdPaths.length} item(s), but ${failed.length} failed: ${summarizeFailedItems(failed)}`;
    type = 'warning';
  } else if (skipped.length > 0) {
    message = `Copied ${createdPaths.length} item(s), skipped ${skipped.length}`;
    type = 'info';
  } else {
    message = `Copied ${formatItemCount(createdPaths.length, sourceItems[0].name)}`;
  }
  if (!canUndo) message += '. Replaced items cannot be undone';

  showToast(
    message,
    canUndo
      ? {
          type,
          action: { label: 'Undo', onClick: () => void useUndoRedoStore.getState().undo() },
        }
      : { type }
  );
  await refreshAfterMutation(onRefresh);
  return !cancelled && failed.length === 0;
}

export async function moveWithUndoAndConflictResolution(
  files: FileEntry[],
  targetDir: string,
  showToast: ShowToastFn,
  onRefresh: RefreshFn,
  options: ConflictResolutionOptions = { conflictResolution: 'ask' }
): Promise<boolean> {
  if (files.length === 0) return false;
  useConflictResolutionStore.getState().reset('move');

  const moveItems: MoveOperation['items'] = [];
  const movedFiles: FileEntry[] = [];
  const completedPolicies: NativeConflictPolicy[] = [];
  const pendingFiles: FileEntry[] = [];
  const pendingPolicies: NativeConflictPolicy[] = [];
  const pendingByTarget = new Map<string, FileEntry>();
  const failed: Array<{ name: string; error: string }> = [];
  const skipped: string[] = [];
  let cancelled = false;

  for (const file of files) {
    const name = describeFileEntry(file).name;
    try {
      const duplicateOf = pendingByTarget.get(batchTargetKey(file));
      const policy = await resolveConflictPolicy(file, targetDir, options, duplicateOf);
      if (!policy) {
        skipped.push(name);
        continue;
      }
      pendingFiles.push(file);
      pendingPolicies.push(policy);
      pendingByTarget.set(batchTargetKey(file), file);
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
        break;
      }
      failed.push({ name, error: formatErrorMessage(error) });
    }
  }

  if (!cancelled && pendingFiles.length > 0) {
    try {
      const result = await runBatch('move', pendingFiles, targetDir, pendingPolicies);
      if (result.targets.length !== pendingFiles.length) {
        throw new Error('Native move completed without all destination paths');
      }
      for (let index = 0; index < pendingFiles.length; index++) {
        const file = pendingFiles[index];
        moveItems.push({
          sourcePath: file.path,
          destPath: result.targets[index],
          name: describeFileEntry(file).name,
        });
        movedFiles.push(file);
        completedPolicies.push(pendingPolicies[index]);
      }
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
      } else {
        failed.push({
          name: formatItemCount(pendingFiles.length, describeFileEntry(pendingFiles[0]).name),
          error: formatErrorMessage(error),
        });
      }
    }
  }

  if (moveItems.length === 0) {
    if (cancelled) {
      showToast('Move cancelled', { type: 'warning' });
      return false;
    }
    if (skipped.length === files.length) {
      showToast('All files were skipped', { type: 'info' });
      return true;
    }
    showToast(`Failed to move: ${failed[0]?.error || 'Unknown error'}`, { type: 'error' });
    return false;
  }

  const operation: MoveOperation = {
    id: generateOperationId(),
    type: 'move',
    timestamp: Date.now(),
    description:
      moveItems.length === 1 ? `Move "${moveItems[0].name}"` : `Move ${moveItems.length} items`,
    items: moveItems,
    undo: async () => {
      try {
        for (let index = 0; index < operation.items.length; index++) {
          const item = operation.items[index];
          const file = movedFiles[index];
          await runOne(
            'move',
            { ...file, path: item.destPath },
            getParentPath(item.sourcePath),
            'error'
          );
        }
        await refreshAfterMutation(onRefresh);
        showToast(`Undid move of ${operation.items.length} item(s)`, { type: 'info' });
        return true;
      } catch (error) {
        showToast(`Failed to undo move: ${formatErrorMessage(error)}`, { type: 'error' });
        return false;
      }
    },
    redo: async () => {
      try {
        const nextItems: MoveOperation['items'] = [];
        for (let index = 0; index < operation.items.length; index++) {
          const item = operation.items[index];
          const file = movedFiles[index];
          const result = await runOne(
            'move',
            { ...file, path: item.sourcePath },
            targetDir,
            completedPolicies[index]
          );
          const target = result.targets[0];
          if (!target) throw new Error('Native move completed without a destination path');
          nextItems.push({ ...item, destPath: target });
        }
        operation.items = nextItems;
        await refreshAfterMutation(onRefresh);
        showToast(`Redid move of ${nextItems.length} item(s)`, { type: 'info' });
        return true;
      } catch (error) {
        showToast(`Failed to redo move: ${formatErrorMessage(error)}`, { type: 'error' });
        return false;
      }
    },
  };
  const canUndo = !completedPolicies.includes('replace');
  if (canUndo) useUndoRedoStore.getState().push(operation);

  let message: string;
  let type: 'success' | 'warning' | 'info' = 'success';
  if (cancelled) {
    message = `Moved ${moveItems.length} item(s) before cancellation`;
    type = 'warning';
  } else if (failed.length > 0) {
    message = `Moved ${moveItems.length} item(s), but ${failed.length} failed: ${summarizeFailedItems(failed)}`;
    type = 'warning';
  } else if (skipped.length > 0) {
    message = `Moved ${moveItems.length} item(s), skipped ${skipped.length}`;
    type = 'info';
  } else {
    message = `Moved ${formatItemCount(moveItems.length, moveItems[0].name)}`;
  }
  if (!canUndo) message += '. Replaced items cannot be undone';

  showToast(
    message,
    canUndo
      ? {
          type,
          action: { label: 'Undo', onClick: () => void useUndoRedoStore.getState().undo() },
        }
      : { type }
  );
  await refreshAfterMutation(onRefresh);
  return !cancelled && failed.length === 0;
}
