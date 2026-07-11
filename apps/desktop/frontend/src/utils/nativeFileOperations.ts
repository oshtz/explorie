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

interface NativeProgress {
  processedEntries: number;
  totalEntries: number;
  processedBytes: number;
  totalBytes: number;
  currentPath?: string | null;
}

interface NativeFileOperationEvent {
  jobId: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  progress?: NativeProgress;
  result?: NativeFileOperationResult;
  error?: string;
}

interface OperationPresentation {
  type: OperationType;
  items: OperationItem[];
  destinationPath?: string;
  conflictResolution: ConflictResolution;
}

export async function runNativeFileOperation(
  request: NativeFileOperationRequest,
  presentation: OperationPresentation
): Promise<NativeFileOperationResult> {
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

    const store = useOperationQueueStore.getState();
    if (payload.progress) {
      store.updateProgress(jobId, {
        processedBytes: payload.progress.processedBytes,
        processedItems: payload.progress.processedEntries,
        totalBytes: payload.progress.totalBytes,
        totalItems: payload.progress.totalEntries,
        currentItem: payload.progress.currentPath ?? undefined,
      });
    }
    if (payload.state === 'completed') {
      const result = payload.result ?? { processedEntries: 0, processedBytes: 0, targets: [] };
      store.updateProgress(jobId, {
        processedBytes: result.processedBytes,
        processedItems: result.processedEntries,
      });
      store.finishOperation(jobId, 'completed');
      resolveCompletion(result);
    } else if (payload.state === 'failed') {
      const error = new Error(payload.error || 'File operation failed');
      store.finishOperation(jobId, 'failed', error.message);
      rejectCompletion(error);
    } else if (payload.state === 'cancelled') {
      const error = new Error('File operation cancelled');
      error.name = 'AbortError';
      store.finishOperation(jobId, 'cancelled');
      rejectCompletion(error);
    }
  };

  const unlisten = await listen<NativeFileOperationEvent>('file-operation', (event) => {
    handleEvent(event.payload);
  });

  try {
    jobId = await invoke<string>('start_file_operation', { request });
    useOperationQueueStore.getState().trackOperation({
      id: jobId,
      ...presentation,
      totalBytes: presentation.items.reduce((sum, item) => sum + item.size, 0),
      totalItems: presentation.items.length,
    });
    for (const event of earlyEvents) handleEvent(event);
    return await completion;
  } finally {
    unlisten();
  }
}
