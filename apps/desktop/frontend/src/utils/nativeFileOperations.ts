import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ConflictResolution, OperationItem, OperationType } from '../operationQueueStore';
import { useOperationQueueStore } from '../operationQueueStore';

export type NativeConflictPolicy = 'error' | 'rename' | 'replace';

export interface NativeFileOperationRequest {
  kind: 'copy' | 'move' | 'trash';
  sources: string[];
  destination: string | null;
  conflictPolicy: NativeConflictPolicy;
}

export interface NativeFileOperationResult {
  processedEntries: number;
  processedBytes: number;
  targets: string[];
}

export interface NativeFileOperationProgress {
  processedEntries: number;
  totalEntries: number;
  processedBytes: number;
  totalBytes: number;
  currentPath?: string | null;
}

type NativeOperationProgressHandler = (progress: NativeFileOperationProgress) => void;

interface NativeFileOperationEvent {
  jobId: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  progress?: NativeFileOperationProgress;
  result?: NativeFileOperationResult;
  error?: string;
}

interface OperationPresentation {
  type: OperationType;
  items: OperationItem[];
  destinationPath?: string;
  conflictResolution: ConflictResolution;
  /** Internal parent-session context; never copied into queue presentation state. */
  operationId?: string;
  trackOperation?: boolean;
  onProgress?: NativeOperationProgressHandler;
}

export async function runNativeFileOperation(
  request: NativeFileOperationRequest,
  presentation: OperationPresentation
): Promise<NativeFileOperationResult> {
  const {
    operationId: parentOperationId,
    trackOperation = true,
    onProgress,
    ...queuePresentation
  } = presentation;
  let jobId: string | undefined;
  const earlyEvents: NativeFileOperationEvent[] = [];
  let resolveCompletion!: (result: NativeFileOperationResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<NativeFileOperationResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const handleEvent = (payload: NativeFileOperationEvent) => {
    if (!jobId) {
      earlyEvents.push(payload);
      return;
    }
    if (payload.jobId !== jobId) return;

    if (payload.progress) {
      if (trackOperation) {
        useOperationQueueStore.getState().updateProgress(jobId, {
          processedBytes: payload.progress.processedBytes,
          processedItems: payload.progress.processedEntries,
          totalBytes: payload.progress.totalBytes,
          totalItems: payload.progress.totalEntries,
          currentItem: payload.progress.currentPath ?? undefined,
        });
      }
      onProgress?.(payload.progress);
    }
    if (payload.state === 'completed') {
      const result = payload.result ?? { processedEntries: 0, processedBytes: 0, targets: [] };
      if (trackOperation) {
        useOperationQueueStore.getState().updateProgress(jobId, {
          processedBytes: result.processedBytes,
          processedItems: result.processedEntries,
        });
        useOperationQueueStore.getState().finishOperation(jobId, 'completed');
      }
      resolveCompletion(result);
    } else if (payload.state === 'failed') {
      const error = new Error(payload.error || 'File operation failed');
      if (trackOperation)
        useOperationQueueStore.getState().finishOperation(jobId, 'failed', error.message);
      rejectCompletion(error);
    } else if (payload.state === 'cancelled') {
      const error = new Error('File operation cancelled');
      error.name = 'AbortError';
      if (trackOperation) useOperationQueueStore.getState().finishOperation(jobId, 'cancelled');
      rejectCompletion(error);
    }
  };

  const unlisten = await listen<NativeFileOperationEvent>('file-operation', (event) => {
    handleEvent(event.payload);
  });

  try {
    jobId = await invoke<string>('start_file_operation', { request });
    if (parentOperationId) {
      const store = useOperationQueueStore.getState();
      store.registerChildJob(parentOperationId, jobId);
      if (store.isCancellationRequested(parentOperationId)) {
        await invoke('cancel_file_operation', { jobId });
      }
    }
    if (trackOperation) {
      useOperationQueueStore.getState().trackOperation({
        id: jobId,
        ...queuePresentation,
        totalBytes: queuePresentation.items.reduce((sum, item) => sum + item.size, 0),
        totalItems: queuePresentation.items.length,
      });
    }
    for (const event of earlyEvents) handleEvent(event);
    return await completion;
  } finally {
    if (parentOperationId && jobId) {
      useOperationQueueStore.getState().unregisterChildJob(parentOperationId, jobId);
    }
    unlisten();
  }
}
