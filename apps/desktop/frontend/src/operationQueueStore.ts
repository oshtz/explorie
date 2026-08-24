import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type OperationType = 'copy' | 'move' | 'delete';
export type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ConflictResolution = 'skip' | 'replace' | 'rename' | 'ask';
export type ItemOutcome = 'pending' | 'completed' | 'skipped' | 'failed' | 'cancelled';

export interface OperationOutcomeCounts {
  completed: number;
  skipped: number;
  failed: number;
  cancelled: number;
}

export interface OperationItem {
  sourcePath: string;
  destPath?: string;
  size: number;
  name: string;
  isDir: boolean;
  outcome?: ItemOutcome;
  error?: string;
}

export interface FileOperation {
  id: string;
  type: OperationType;
  status: OperationStatus;
  items: OperationItem[];
  destinationPath?: string;
  totalBytes: number;
  processedBytes: number;
  totalItems: number;
  processedItems: number;
  currentItem?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  conflictResolution: ConflictResolution;
  outcomes?: OperationOutcomeCounts;
  /** The destination captured when the transfer was started. Session-only retry guard. */
  destinationSnapshot?: string;
}

type ProgressUpdate = Partial<
  Pick<
    FileOperation,
    'processedBytes' | 'processedItems' | 'totalBytes' | 'totalItems' | 'currentItem'
  >
>;

interface OperationQueueState {
  operations: FileOperation[];
  defaultConflictResolution: ConflictResolution;
  showProgressPanel: boolean;
  trackOperation: (
    operation: Omit<FileOperation, 'status' | 'startedAt' | 'processedBytes' | 'processedItems'>
  ) => void;
  updateProgress: (id: string, update: ProgressUpdate) => void;
  finishOperation: (
    id: string,
    status: Exclude<OperationStatus, 'running'>,
    error?: string
  ) => void;
  beginRetryOperation: (id: string) => void;
  cancelOperation: (id: string) => Promise<void>;
  removeOperation: (id: string) => void;
  clearCompleted: () => void;
  setDefaultConflictResolution: (resolution: ConflictResolution) => void;
  setShowProgressPanel: (show: boolean) => void;
  getRunningOperations: () => FileOperation[];
  hasActiveOperations: () => boolean;
  updateItemOutcome: (
    operationId: string,
    sourcePathOrIndex: string | number,
    outcome: ItemOutcome,
    error?: string,
    destPath?: string
  ) => void;
  setOperationOutcomeCounts: (operationId: string, outcomes: OperationOutcomeCounts) => void;
  getRetryableItems: (operationId: string) => OperationItem[];
  registerChildJob: (operationId: string, childJobId: string) => void;
  unregisterChildJob: (operationId: string, childJobId: string) => void;
  isCancellationRequested: (operationId: string) => boolean;
}

const childJobs = new Map<string, Set<string>>();
const cancellationRequests = new Set<string>();

function outcomeCounts(items: OperationItem[]): OperationOutcomeCounts {
  return items.reduce<OperationOutcomeCounts>(
    (counts, item) => {
      if (item.outcome === 'completed') counts.completed += 1;
      else if (item.outcome === 'skipped') counts.skipped += 1;
      else if (item.outcome === 'failed') counts.failed += 1;
      else if (item.outcome === 'cancelled') counts.cancelled += 1;
      return counts;
    },
    { completed: 0, skipped: 0, failed: 0, cancelled: 0 }
  );
}

export const useOperationQueueStore = create<OperationQueueState>((set, get) => ({
  operations: [],
  defaultConflictResolution: 'ask',
  showProgressPanel: false,

  trackOperation: (operation) => {
    const items = operation.items.map((item) => ({
      ...item,
      outcome: item.outcome ?? 'pending',
    }));
    set((state) => ({
      operations: [
        ...state.operations.filter((item) => item.id !== operation.id),
        {
          ...operation,
          items,
          status: 'running',
          startedAt: Date.now(),
          processedBytes: 0,
          processedItems: 0,
          outcomes: outcomeCounts(items),
          destinationSnapshot: operation.destinationSnapshot ?? operation.destinationPath,
        },
      ],
      showProgressPanel: true,
    }));
  },

  updateProgress: (id, update) => {
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.id === id ? { ...operation, ...update } : operation
      ),
    }));
  },

  finishOperation: (id, status, error) => {
    set((state) => ({
      operations: state.operations.map((operation) => {
        if (operation.id !== id) return operation;
        const terminalOutcome: ItemOutcome =
          status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
        const items = operation.items.map((item) =>
          item.outcome && item.outcome !== 'pending'
            ? item
            : {
                ...item,
                outcome: terminalOutcome,
                ...(terminalOutcome === 'failed' && error ? { error } : {}),
              }
        );
        return {
          ...operation,
          items,
          status,
          error,
          completedAt: Date.now(),
          outcomes: outcomeCounts(items),
        };
      }),
    }));
    childJobs.delete(id);
    cancellationRequests.delete(id);
  },

  beginRetryOperation: (id) => {
    cancellationRequests.delete(id);
    set((state) => ({
      operations: state.operations.map((operation) => {
        if (operation.id !== id) return operation;
        const settledItems = operation.items.filter(
          (item) => item.outcome === 'completed' || item.outcome === 'skipped'
        );
        return {
          ...operation,
          status: 'running',
          completedAt: undefined,
          error: undefined,
          processedBytes: settledItems.reduce((total, item) => total + item.size, 0),
          processedItems: settledItems.length,
          currentItem: undefined,
        };
      }),
    }));
  },

  cancelOperation: async (id) => {
    const operation = get().operations.find((item) => item.id === id);
    if (!operation || operation.status !== 'running') return;
    cancellationRequests.add(id);
    const activeChildren = childJobs.get(id);
    const jobsToCancel = activeChildren?.size ? [...activeChildren] : [id];
    await Promise.all(jobsToCancel.map((jobId) => invoke('cancel_file_operation', { jobId })));
  },

  removeOperation: (id) => {
    set((state) => ({ operations: state.operations.filter((operation) => operation.id !== id) }));
  },

  clearCompleted: () => {
    set((state) => ({
      operations: state.operations.filter((operation) => operation.status === 'running'),
    }));
  },

  setDefaultConflictResolution: (resolution) => set({ defaultConflictResolution: resolution }),
  setShowProgressPanel: (show) => set({ showProgressPanel: show }),
  getRunningOperations: () =>
    get().operations.filter((operation) => operation.status === 'running'),
  hasActiveOperations: () => get().operations.some((operation) => operation.status === 'running'),

  updateItemOutcome: (operationId, sourcePathOrIndex, outcome, error, destPath) => {
    set((state) => ({
      operations: state.operations.map((operation) => {
        if (operation.id !== operationId) return operation;
        const items = operation.items.map((item, index) =>
          (
            typeof sourcePathOrIndex === 'number'
              ? index === sourcePathOrIndex
              : item.sourcePath === sourcePathOrIndex
          )
            ? {
                ...item,
                outcome,
                ...(error ? { error } : { error: undefined }),
                ...(destPath ? { destPath } : {}),
              }
            : item
        );
        return { ...operation, items, outcomes: outcomeCounts(items) };
      }),
    }));
  },

  setOperationOutcomeCounts: (operationId, outcomes) => {
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.id === operationId ? { ...operation, outcomes } : operation
      ),
    }));
  },

  getRetryableItems: (operationId) => {
    const operation = get().operations.find((item) => item.id === operationId);
    if (!operation || (operation.type !== 'copy' && operation.type !== 'move')) return [];
    return operation.items.filter(
      (item) => item.outcome === 'failed' || item.outcome === 'cancelled'
    );
  },

  registerChildJob: (operationId, childJobId) => {
    const jobs = childJobs.get(operationId) ?? new Set<string>();
    jobs.add(childJobId);
    childJobs.set(operationId, jobs);
  },

  unregisterChildJob: (operationId, childJobId) => {
    const jobs = childJobs.get(operationId);
    if (!jobs) return;
    jobs.delete(childJobId);
    if (jobs.size === 0) childJobs.delete(operationId);
  },

  isCancellationRequested: (operationId) => cancellationRequests.has(operationId),
}));

export const useHasActiveOperations = () =>
  useOperationQueueStore((state) =>
    state.operations.some((operation) => operation.status === 'running')
  );

export const useShowProgressPanel = () =>
  useOperationQueueStore((state) => state.showProgressPanel);

export const useActiveOperationsCount = () =>
  useOperationQueueStore(
    (state) => state.operations.filter((operation) => operation.status === 'running').length
  );

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
