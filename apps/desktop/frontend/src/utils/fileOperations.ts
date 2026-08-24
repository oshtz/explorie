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
import type { ConflictAction } from '../conflictResolutionStore';
import { checkForConflict, useConflictResolutionStore } from '../conflictResolutionStore';
import { deletePath, fileExists } from './fs';
import { formatErrorMessage } from './errorMessages';
import { describeFileEntry, formatItemCount, summarizeFailedItems } from './fileOperationFormat';
import { getParentPath } from './path';
import { loadRemoteDrives } from './remoteDrives';
import {
  useOperationQueueStore,
  type ConflictResolution,
  type FileOperation,
  type ItemOutcome,
  type OperationItem,
} from '../operationQueueStore';
import {
  runNativeFileOperation,
  type NativeConflictPolicy,
  type NativeFileOperationResult,
  type NativeFileOperationProgress,
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

const transferRefreshHandlers = new Map<string, RefreshFn>();

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
  options: ConflictResolutionOptions
): Promise<NativeConflictPolicy | null> {
  const conflict = await checkForConflict(file.path, targetDir, file.is_dir);
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

async function runOne(
  kind: 'copy' | 'move',
  file: FileEntry,
  targetDir: string,
  policy: NativeConflictPolicy,
  operationId?: string,
  onProgress?: (progress: NativeFileOperationProgress) => void
): Promise<NativeFileOperationResult> {
  const request = {
    kind,
    sources: [file.path],
    destination: targetDir,
    conflictPolicy: policy,
  };
  const presentation = {
    type: kind,
    items: [presentationItem(file)],
    destinationPath: targetDir,
    conflictResolution: presentationPolicy(policy),
  };
  if (!operationId) return runNativeFileOperation(request, presentation);
  return runNativeFileOperation(request, {
    ...presentation,
    operationId,
    trackOperation: false,
    onProgress,
  });
}

async function refreshAfterMutation(onRefresh: RefreshFn): Promise<void> {
  clearDirSizeCache();
  await onRefresh();
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function queueConflictResolution(options: ConflictResolutionOptions): ConflictResolution {
  return options.conflictResolution === 'keepBoth' ? 'rename' : options.conflictResolution;
}

function createTransferOperation(
  id: string,
  type: 'copy' | 'move',
  files: FileEntry[],
  destinationPath: string,
  options: ConflictResolutionOptions,
  onRefresh: RefreshFn
): void {
  transferRefreshHandlers.set(id, onRefresh);
  useOperationQueueStore.getState().trackOperation({
    id,
    type,
    items: files.map(presentationItem),
    destinationPath,
    destinationSnapshot: destinationPath,
    totalBytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0),
    totalItems: files.length,
    conflictResolution: queueConflictResolution(options),
  });
}

function updateTransferItem(
  operationId: string,
  sourcePath: string,
  outcome: ItemOutcome,
  error?: string,
  destPath?: string
): void {
  useOperationQueueStore
    .getState()
    .updateItemOutcome(operationId, sourcePath, outcome, error, destPath);
}

function markCancelledItems(operationId: string, files: FileEntry[], fromIndex: number): void {
  for (const file of files.slice(fromIndex)) {
    updateTransferItem(operationId, file.path, 'cancelled', 'Operation cancelled');
  }
}

function currentTransferCounts(operationId: string) {
  const operation = useOperationQueueStore
    .getState()
    .operations.find((item) => item.id === operationId);
  return operation?.outcomes ?? { completed: 0, skipped: 0, failed: 0, cancelled: 0 };
}

function finishTransferOperation(operationId: string): void {
  const counts = currentTransferCounts(operationId);
  const status = counts.failed > 0 ? 'failed' : counts.cancelled > 0 ? 'cancelled' : 'completed';
  const error = counts.failed > 0 ? `${counts.failed} item(s) failed` : undefined;
  useOperationQueueStore.getState().finishOperation(operationId, status, error);
}

function retryOptions(operation: FileOperation): ConflictResolutionOptions {
  switch (operation.conflictResolution) {
    case 'replace':
      return { conflictResolution: 'replace' };
    case 'rename':
      return { conflictResolution: 'keepBoth' };
    case 'skip':
      return { conflictResolution: 'skip' };
    default:
      return { conflictResolution: 'ask' };
  }
}

function normalizePathForComparison(path: string): string {
  const normalized = path
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalized || '/';
}

function configuredRemoteMountRoots(): string[] {
  return loadRemoteDrives().flatMap(({ mountTarget }) => {
    const target = normalizePathForComparison(mountTarget.trim());
    if (!target) return [];
    if (/^[a-z]:$/.test(target)) return [`${target}/`];
    if (target.startsWith('/')) return [target];
    return [`/volumes/${target}`];
  });
}

function remoteMountRootForPath(path: string, roots: string[]): string | undefined {
  const normalizedPath = normalizePathForComparison(path);
  return roots.find((root) => {
    const normalizedRoot = normalizePathForComparison(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

function isTransientRemoteError(error?: string): boolean {
  return /remote|network|offline|unavailable|disconnected|timed? ?out/i.test(error ?? '');
}

async function validateRetryPaths(
  operation: FileOperation,
  items: OperationItem[],
  showToast: ShowToastFn
): Promise<boolean> {
  const destinationSnapshot = operation.destinationSnapshot ?? operation.destinationPath;
  if (!operation.destinationPath || operation.destinationPath !== destinationSnapshot) {
    showToast('Cannot retry: the original destination has changed.', { type: 'error' });
    return false;
  }
  const remoteRoots = configuredRemoteMountRoots();
  const mountAvailability = new Map<string, Promise<boolean>>();
  const isRemoteMountUnavailable = async (path: string): Promise<boolean> => {
    const root = remoteMountRootForPath(path, remoteRoots);
    if (!root) return false;
    let available = mountAvailability.get(root);
    if (!available) {
      available = fileExists(root);
      mountAvailability.set(root, available);
    }
    return !(await available);
  };

  const destinationUnavailable = !(await fileExists(operation.destinationPath));
  const destinationMayBeTransient =
    items.some((item) => isTransientRemoteError(item.error)) ||
    (destinationUnavailable && (await isRemoteMountUnavailable(operation.destinationPath)));
  if (destinationUnavailable && !destinationMayBeTransient) {
    showToast('Cannot retry: the original destination is no longer available.', {
      type: 'error',
    });
    return false;
  }
  const missing = [] as string[];
  for (const item of items) {
    const sourceUnavailable = !(await fileExists(item.sourcePath));
    const sourceMayBeTransient =
      isTransientRemoteError(item.error) && sourceUnavailable
        ? true
        : sourceUnavailable && (await isRemoteMountUnavailable(item.sourcePath));
    if (sourceUnavailable && !sourceMayBeTransient) {
      missing.push(item.name);
    }
  }
  if (missing.length > 0) {
    showToast(`Cannot retry: source is no longer available (${missing.join(', ')}).`, {
      type: 'error',
    });
    return false;
  }
  return true;
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
  options: ConflictResolutionOptions = { conflictResolution: 'ask' },
  operationId?: string
): Promise<boolean> {
  if (files.length === 0) return false;
  useConflictResolutionStore.getState().reset('copy');

  const transferId = operationId ?? generateOperationId();
  if (!operationId) {
    createTransferOperation(transferId, 'copy', files, targetDir, options, onRefresh);
  }

  const createdPaths: string[] = [];
  const sourceItems: CopyOperation['sourceItems'] = [];
  const completedFiles: FileEntry[] = [];
  const completedPolicies: NativeConflictPolicy[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const skipped: string[] = [];
  let cancelled = false;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const name = describeFileEntry(file).name;
    if (useOperationQueueStore.getState().isCancellationRequested(transferId)) {
      markCancelledItems(transferId, files, index);
      cancelled = true;
      break;
    }
    try {
      const policy = await resolveConflictPolicy(file, targetDir, options);
      if (!policy) {
        skipped.push(name);
        updateTransferItem(transferId, file.path, 'skipped');
        const current = useOperationQueueStore
          .getState()
          .operations.find((item) => item.id === transferId);
        useOperationQueueStore.getState().updateProgress(transferId, {
          processedItems: (current?.processedItems ?? 0) + 1,
        });
        continue;
      }
      const before = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      const result = await runOne('copy', file, targetDir, policy, transferId, (progress) => {
        const base = useOperationQueueStore
          .getState()
          .operations.find((item) => item.id === transferId);
        useOperationQueueStore.getState().updateProgress(transferId, {
          processedBytes: (before?.processedBytes ?? 0) + progress.processedBytes,
          processedItems: base?.processedItems ?? before?.processedItems ?? 0,
          currentItem: progress.currentPath ?? file.path,
        });
      });
      const target = result.targets[0];
      if (!target) throw new Error('Native copy completed without a destination path');
      createdPaths.push(target);
      sourceItems.push({ path: file.path, name });
      completedFiles.push(file);
      completedPolicies.push(policy);
      updateTransferItem(transferId, file.path, 'completed', undefined, target);
      const current = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      useOperationQueueStore.getState().updateProgress(transferId, {
        processedBytes: (before?.processedBytes ?? 0) + result.processedBytes,
        processedItems: (current?.processedItems ?? before?.processedItems ?? 0) + 1,
        currentItem: undefined,
      });
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
        updateTransferItem(transferId, file.path, 'cancelled', 'Operation cancelled');
        markCancelledItems(transferId, files, index + 1);
        break;
      }
      const errorMessage = formatErrorMessage(error);
      failed.push({ name, error: errorMessage });
      updateTransferItem(transferId, file.path, 'failed', errorMessage);
      const current = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      useOperationQueueStore.getState().updateProgress(transferId, {
        processedItems: (current?.processedItems ?? 0) + 1,
        currentItem: undefined,
      });
    }
  }

  finishTransferOperation(transferId);

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
  options: ConflictResolutionOptions = { conflictResolution: 'ask' },
  operationId?: string
): Promise<boolean> {
  if (files.length === 0) return false;
  useConflictResolutionStore.getState().reset('move');

  const transferId = operationId ?? generateOperationId();
  if (!operationId) {
    createTransferOperation(transferId, 'move', files, targetDir, options, onRefresh);
  }

  const moveItems: MoveOperation['items'] = [];
  const movedFiles: FileEntry[] = [];
  const completedPolicies: NativeConflictPolicy[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  const skipped: string[] = [];
  let cancelled = false;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const name = describeFileEntry(file).name;
    if (useOperationQueueStore.getState().isCancellationRequested(transferId)) {
      markCancelledItems(transferId, files, index);
      cancelled = true;
      break;
    }
    try {
      const policy = await resolveConflictPolicy(file, targetDir, options);
      if (!policy) {
        skipped.push(name);
        updateTransferItem(transferId, file.path, 'skipped');
        const current = useOperationQueueStore
          .getState()
          .operations.find((item) => item.id === transferId);
        useOperationQueueStore.getState().updateProgress(transferId, {
          processedItems: (current?.processedItems ?? 0) + 1,
        });
        continue;
      }
      const before = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      const result = await runOne('move', file, targetDir, policy, transferId, (progress) => {
        const current = useOperationQueueStore
          .getState()
          .operations.find((item) => item.id === transferId);
        useOperationQueueStore.getState().updateProgress(transferId, {
          processedBytes: (before?.processedBytes ?? 0) + progress.processedBytes,
          processedItems: current?.processedItems ?? before?.processedItems ?? 0,
          currentItem: progress.currentPath ?? file.path,
        });
      });
      const target = result.targets[0];
      if (!target) throw new Error('Native move completed without a destination path');
      moveItems.push({ sourcePath: file.path, destPath: target, name });
      movedFiles.push(file);
      completedPolicies.push(policy);
      updateTransferItem(transferId, file.path, 'completed', undefined, target);
      const current = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      useOperationQueueStore.getState().updateProgress(transferId, {
        processedBytes: (before?.processedBytes ?? 0) + result.processedBytes,
        processedItems: (current?.processedItems ?? before?.processedItems ?? 0) + 1,
        currentItem: undefined,
      });
    } catch (error) {
      if (isCancellation(error)) {
        cancelled = true;
        updateTransferItem(transferId, file.path, 'cancelled', 'Operation cancelled');
        markCancelledItems(transferId, files, index + 1);
        break;
      }
      const errorMessage = formatErrorMessage(error);
      failed.push({ name, error: errorMessage });
      updateTransferItem(transferId, file.path, 'failed', errorMessage);
      const current = useOperationQueueStore
        .getState()
        .operations.find((item) => item.id === transferId);
      useOperationQueueStore.getState().updateProgress(transferId, {
        processedItems: (current?.processedItems ?? 0) + 1,
        currentItem: undefined,
      });
    }
  }

  finishTransferOperation(transferId);

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

export async function retryFailedOrCancelledItems(
  operationId: string,
  showToast: ShowToastFn,
  onRefresh?: RefreshFn
): Promise<boolean> {
  const operation = useOperationQueueStore
    .getState()
    .operations.find((item) => item.id === operationId);
  if (!operation) {
    showToast('Operation is no longer available.', { type: 'error' });
    return false;
  }
  if (operation.type === 'delete') {
    showToast('Delete operations cannot be retried.', { type: 'error' });
    return false;
  }
  if (operation.status === 'running') {
    showToast('This operation is still in progress.', { type: 'info' });
    return false;
  }

  const retryableItems = useOperationQueueStore.getState().getRetryableItems(operationId);
  if (retryableItems.length === 0) {
    showToast('There are no failed or cancelled items to retry.', { type: 'info' });
    return false;
  }

  const files: FileEntry[] = retryableItems.map((item) => ({
    id: item.sourcePath,
    path: item.sourcePath,
    name: item.name,
    size: item.size,
    modified: new Date(0).toISOString(),
    hidden: false,
    is_dir: item.isDir,
    custom: {},
  }));

  if (!(await validateRetryPaths(operation, retryableItems, showToast))) return false;

  try {
    useOperationQueueStore.getState().beginRetryOperation(operationId);
    const options = retryOptions(operation);
    const refresh = onRefresh ?? transferRefreshHandlers.get(operationId) ?? (() => undefined);
    const result =
      operation.type === 'copy'
        ? await copyWithUndoAndConflictResolution(
            files,
            operation.destinationPath!,
            showToast,
            refresh,
            options,
            operationId
          )
        : await moveWithUndoAndConflictResolution(
            files,
            operation.destinationPath!,
            showToast,
            refresh,
            options,
            operationId
          );
    return result;
  } catch (error) {
    showToast(`Retry failed: ${formatErrorMessage(error)}`, { type: 'error' });
    return false;
  }
}
