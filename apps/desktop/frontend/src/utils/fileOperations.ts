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
import { describeFileEntry, formatItemCount } from './fileOperationFormat';
import { getParentPath, joinPaths, pathsEqual } from './path';
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
  reservedTargets: ReadonlySet<string>
): Promise<NativeConflictPolicy | null> {
  const descriptor = describeFileEntry(file);
  const targetPath = joinPaths(targetDir, descriptor.name);
  const hasReservedTarget = [...reservedTargets].some((reserved) =>
    pathsEqual(targetPath, reserved)
  );
  const conflict = hasReservedTarget
    ? reservedTargetConflict(file, targetPath, descriptor.name)
    : await checkForConflict(file.path, targetDir, file.is_dir);
  if (!conflict) return 'error';

  let action: ConflictAction;
  if (options.conflictResolution === 'ask') {
    action = await useConflictResolutionStore.getState().queueConflict(conflict);
  } else {
    action = options.conflictResolution;
  }

  if (action === 'skip') return null;
  return action === 'replace' ? 'replace' : 'rename';
}

function reservedTargetConflict(file: FileEntry, targetPath: string, name: string): ConflictInfo {
  return {
    sourcePath: file.path,
    sourceName: name,
    sourceSize: file.size,
    sourceIsDir: file.is_dir,
    destPath: targetPath,
    destName: name,
    destIsDir: file.is_dir,
  };
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
  const conflictPolicy = policies[0] ?? 'error';
  const conflictPolicies = policies.every((policy) => policy === conflictPolicy)
    ? undefined
    : policies;
  return runNativeFileOperation(
    {
      kind,
      sources: files.map((file) => file.path),
      destination: targetDir,
      conflictPolicy,
      ...(conflictPolicies ? { conflictPolicies } : {}),
    },
    {
      type: kind,
      items: files.map(presentationItem),
      destinationPath: targetDir,
      conflictResolution:
        conflictPolicies === undefined ? presentationPolicy(conflictPolicy) : 'ask',
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
    if (isCancellation(error)) {
      showToast('Delete cancelled', { type: 'warning' });
    } else {
      showToast(`Failed to move items to Trash: ${formatErrorMessage(error)}`, {
        type: 'error',
      });
    }
    await refreshAfterMutation(onRefresh);
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

  const selectedFiles: FileEntry[] = [];
  const selectedPolicies: NativeConflictPolicy[] = [];
  const skipped: string[] = [];
  const reservedTargets = new Set<string>();

  try {
    for (const file of files) {
      const name = describeFileEntry(file).name;
      const policy = await resolveConflictPolicy(file, targetDir, options, reservedTargets);
      if (!policy) {
        skipped.push(name);
        continue;
      }
      selectedFiles.push(file);
      selectedPolicies.push(policy);
      reservedTargets.add(joinPaths(targetDir, name));
    }
  } catch (error) {
    showToast(`Failed to copy: ${formatErrorMessage(error)}`, { type: 'error' });
    return false;
  }

  if (selectedFiles.length === 0) {
    showToast('All files were skipped', { type: 'info' });
    return true;
  }

  let result: NativeFileOperationResult;
  try {
    result = await runBatch('copy', selectedFiles, targetDir, selectedPolicies);
  } catch (error) {
    if (isCancellation(error)) {
      showToast('Copy cancelled', { type: 'warning' });
    } else {
      showToast(`Failed to copy: ${formatErrorMessage(error)}`, { type: 'error' });
    }
    return false;
  }

  if (result.targets.length !== selectedFiles.length) {
    showToast('Failed to copy: native operation returned incomplete destination paths', {
      type: 'error',
    });
    return false;
  }

  const createdPaths = result.targets;
  const sourceItems: CopyOperation['sourceItems'] = selectedFiles.map((file) => ({
    path: file.path,
    name: describeFileEntry(file).name,
  }));
  const completedFiles = selectedFiles;
  const completedPolicies = selectedPolicies;

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
        const redoResult = await runBatch('copy', completedFiles, targetDir, completedPolicies);
        if (redoResult.targets.length !== completedFiles.length) {
          throw new Error('Native copy returned incomplete destination paths');
        }
        const newPaths = redoResult.targets;
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

  let message =
    skipped.length > 0
      ? `Copied ${createdPaths.length} item(s), skipped ${skipped.length}`
      : `Copied ${formatItemCount(createdPaths.length, sourceItems[0].name)}`;
  if (!canUndo) message += '. Replaced items cannot be undone';

  showToast(
    message,
    canUndo
      ? {
          type: skipped.length > 0 ? 'info' : 'success',
          action: { label: 'Undo', onClick: () => void useUndoRedoStore.getState().undo() },
        }
      : { type: skipped.length > 0 ? 'info' : 'success' }
  );
  await refreshAfterMutation(onRefresh);
  return true;
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

  const selectedFiles: FileEntry[] = [];
  const selectedPolicies: NativeConflictPolicy[] = [];
  const skipped: string[] = [];
  const reservedTargets = new Set<string>();

  try {
    for (const file of files) {
      const name = describeFileEntry(file).name;
      const policy = await resolveConflictPolicy(file, targetDir, options, reservedTargets);
      if (!policy) {
        skipped.push(name);
        continue;
      }
      selectedFiles.push(file);
      selectedPolicies.push(policy);
      reservedTargets.add(joinPaths(targetDir, name));
    }
  } catch (error) {
    showToast(`Failed to move: ${formatErrorMessage(error)}`, { type: 'error' });
    return false;
  }

  if (selectedFiles.length === 0) {
    showToast('All files were skipped', { type: 'info' });
    return true;
  }

  let result: NativeFileOperationResult;
  try {
    result = await runBatch('move', selectedFiles, targetDir, selectedPolicies);
  } catch (error) {
    if (isCancellation(error)) {
      showToast('Move cancelled', { type: 'warning' });
    } else {
      showToast(`Failed to move: ${formatErrorMessage(error)}`, { type: 'error' });
    }
    return false;
  }

  if (result.targets.length !== selectedFiles.length) {
    showToast('Failed to move: native operation returned incomplete destination paths', {
      type: 'error',
    });
    return false;
  }

  const moveItems: MoveOperation['items'] = selectedFiles.map((file, index) => ({
    sourcePath: file.path,
    destPath: result.targets[index],
    name: describeFileEntry(file).name,
  }));
  const movedFiles = selectedFiles;
  const completedPolicies = selectedPolicies;

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
        const redoFiles = operation.items.map((item, index) => ({
          ...movedFiles[index],
          path: item.sourcePath,
        }));
        const redoResult = await runBatch('move', redoFiles, targetDir, completedPolicies);
        if (redoResult.targets.length !== redoFiles.length) {
          throw new Error('Native move returned incomplete destination paths');
        }
        const nextItems: MoveOperation['items'] = operation.items.map((item, index) => ({
          ...item,
          destPath: redoResult.targets[index],
        }));
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

  let message =
    skipped.length > 0
      ? `Moved ${moveItems.length} item(s), skipped ${skipped.length}`
      : `Moved ${formatItemCount(moveItems.length, moveItems[0].name)}`;
  if (!canUndo) message += '. Replaced items cannot be undone';

  showToast(
    message,
    canUndo
      ? {
          type: skipped.length > 0 ? 'info' : 'success',
          action: { label: 'Undo', onClick: () => void useUndoRedoStore.getState().undo() },
        }
      : { type: skipped.length > 0 ? 'info' : 'success' }
  );
  await refreshAfterMutation(onRefresh);
  return true;
}
