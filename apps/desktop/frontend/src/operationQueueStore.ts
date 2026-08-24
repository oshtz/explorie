import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type OperationType = 'copy' | 'move' | 'delete';
export type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ConflictResolution = 'skip' | 'replace' | 'rename' | 'ask';
export type ItemOutcome = 'pending' | 'completed' | 'skipped' | 'failed' | 'cancelled';

export interface DestinationIdentity {
  path: string;
  isDir: boolean;
  birthtimeMs: number | null;
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
  destinationIdentity?: DestinationIdentity;
  nativeJobId?: string;
  totalBytes: number;
  processedBytes: number;
  totalItems: number;
  processedItems: number;
  currentItem?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  conflictResolution: ConflictResolution;
  outcomes?: {
    completed: number;
    skipped: number;
    failed: number;
    cancelled: number;
  };
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
  cancelOperation: (id: string) => Promise<void>;
  removeOperation: (id: string) => void;
  clearCompleted: () => void;
  setDefaultConflictResolution: (resolution: ConflictResolution) => void;
  setShowProgressPanel: (show: boolean) => void;
  getRunningOperations: () => FileOperation[];
  hasActiveOperations: () => boolean;
  updateItemOutcome: (
    operationId: string,
    itemIndex: number,
    outcome: ItemOutcome,
    error?: string
  ) => void;
  setOperationOutcomeCounts: (
    operationId: string,
    outcomes: {
      completed: number;
      skipped: number;
      failed: number;
      cancelled: number;
    }
  ) => void;
  getRetryableItems: (operationId: string) => OperationItem[];
  setDestinationIdentity: (operationId: string, identity: DestinationIdentity) => void;
  setNativeJobId: (operationId: string, nativeJobId: string) => void;
  beginRetryOperation: (operationId: string) => void;
}

let queueOperationIdCounter = 0;

export function generateQueueOperationId(): string {
  return `queue-${Date.now()}-${++queueOperationIdCounter}`;
}

export const useOperationQueueStore = create<OperationQueueState>((set, get) => ({
  operations: [],
  defaultConflictResolution: 'ask',
  showProgressPanel: false,

  trackOperation: (operation) => {
    set((state) => ({
      operations: [
        ...state.operations.filter((item) => item.id !== operation.id),
        {
          ...operation,
          status: 'running',
          startedAt: Date.now(),
          processedBytes: 0,
          processedItems: 0,
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
        return { ...operation, status, error, completedAt: Date.now(), nativeJobId: undefined };
      }),
    }));
  },

  cancelOperation: async (id) => {
    const operation = get().operations.find((item) => item.id === id);
    await invoke('cancel_file_operation', { jobId: operation?.nativeJobId ?? id });
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

  updateItemOutcome: (operationId, itemIndex, outcome, error) => {
    set((state) => ({
      operations: state.operations.map((operation) => {
        if (operation.id !== operationId) return operation;
        const items = [...operation.items];
        if (itemIndex >= 0 && itemIndex < items.length) {
          items[itemIndex] = { ...items[itemIndex], outcome, error };
        }
        return { ...operation, items };
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
    if (!operation || (operation.type !== 'copy' && operation.type !== 'move')) {
      return [];
    }
    return operation.items.filter(
      (item) => item.outcome === 'failed' || item.outcome === 'cancelled'
    );
  },

  setDestinationIdentity: (operationId, identity) => {
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.id === operationId ? { ...operation, destinationIdentity: identity } : operation
      ),
    }));
  },

  setNativeJobId: (operationId, nativeJobId) => {
    set((state) => ({
      operations: state.operations.map((operation) =>
        operation.id === operationId ? { ...operation, nativeJobId } : operation
      ),
    }));
  },

  beginRetryOperation: (operationId) => {
    set((state) => ({
      operations: state.operations.map((operation) => {
        if (operation.id !== operationId) return operation;
        const baseline = operation.items.filter(
          (item) => item.outcome === 'completed' || item.outcome === 'skipped'
        );
        return {
          ...operation,
          status: 'running' as const,
          error: undefined,
          completedAt: undefined,
          currentItem: undefined,
          processedItems: baseline.length,
          processedBytes: baseline.reduce((sum, item) => sum + item.size, 0),
        };
      }),
    }));
  },
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
