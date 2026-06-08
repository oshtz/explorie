/**
 * File Operation Queue Store
 * Manages a queue of file operations (copy, move, delete, compress, extract)
 * with progress tracking, pause/resume, and cancellation support.
 */
import { create } from 'zustand';

export type OperationType = 'copy' | 'move' | 'delete' | 'compress' | 'extract';

export type OperationStatus =
  | 'pending' // Waiting in queue
  | 'running' // Currently executing
  | 'paused' // Paused by user
  | 'completed' // Successfully finished
  | 'failed' // Failed with error
  | 'cancelled'; // Cancelled by user

export type ConflictResolution = 'skip' | 'replace' | 'rename' | 'ask';

export interface OperationItem {
  sourcePath: string;
  destPath?: string;
  size: number;
  name: string;
  isDir: boolean;
}

export interface FileOperation {
  id: string;
  type: OperationType;
  status: OperationStatus;
  items: OperationItem[];
  destinationPath?: string;

  // Progress tracking
  totalBytes: number;
  processedBytes: number;
  totalItems: number;
  processedItems: number;
  currentItem?: string;

  // Timing
  startedAt?: number;
  completedAt?: number;
  estimatedTimeRemaining?: number; // ms
  speed?: number; // bytes per second

  // Error handling
  error?: string;
  failedItems: Array<{ path: string; error: string }>;

  // Conflict handling
  conflictResolution: ConflictResolution;
  conflicts: Array<{ sourcePath: string; destPath: string }>;

  // Cancellation
  abortController?: AbortController;
}

interface OperationQueueState {
  operations: FileOperation[];
  maxConcurrent: number;
  defaultConflictResolution: ConflictResolution;
  showProgressPanel: boolean;

  // Completion callback for notifications
  onOperationComplete: ((operation: FileOperation) => void) | null;
  setOnOperationComplete: (callback: ((operation: FileOperation) => void) | null) => void;

  // Actions
  addOperation: (
    op: Omit<
      FileOperation,
      | 'id'
      | 'status'
      | 'processedBytes'
      | 'processedItems'
      | 'failedItems'
      | 'conflicts'
      | 'abortController'
    >
  ) => string;
  removeOperation: (id: string) => void;
  clearCompleted: () => void;

  // Operation control
  startOperation: (id: string) => void;
  pauseOperation: (id: string) => void;
  resumeOperation: (id: string) => void;
  cancelOperation: (id: string) => void;
  retryOperation: (id: string) => void;

  // Progress updates
  updateProgress: (
    id: string,
    update: Partial<
      Pick<
        FileOperation,
        'processedBytes' | 'processedItems' | 'currentItem' | 'speed' | 'estimatedTimeRemaining'
      >
    >
  ) => void;
  setOperationStatus: (id: string, status: OperationStatus, error?: string) => void;
  addFailedItem: (id: string, path: string, error: string) => void;
  addConflict: (id: string, sourcePath: string, destPath: string) => void;
  resolveConflict: (id: string, resolution: ConflictResolution) => void;

  // Settings
  setMaxConcurrent: (n: number) => void;
  setDefaultConflictResolution: (resolution: ConflictResolution) => void;
  setShowProgressPanel: (show: boolean) => void;

  // Computed
  getRunningOperations: () => FileOperation[];
  getPendingOperations: () => FileOperation[];
  hasActiveOperations: () => boolean;
}

let operationIdCounter = 0;

export function generateOperationId(): string {
  return `op-${Date.now()}-${++operationIdCounter}`;
}

export const useOperationQueueStore = create<OperationQueueState>((set, get) => ({
  operations: [],
  maxConcurrent: 2,
  defaultConflictResolution: 'ask',
  showProgressPanel: false,
  onOperationComplete: null,

  setOnOperationComplete: (callback) => set({ onOperationComplete: callback }),

  addOperation: (op) => {
    const id = generateOperationId();
    const operation: FileOperation = {
      ...op,
      id,
      status: 'pending',
      processedBytes: 0,
      processedItems: 0,
      failedItems: [],
      conflicts: [],
      abortController: new AbortController(),
    };

    set((state) => ({
      operations: [...state.operations, operation],
      showProgressPanel: true,
    }));

    // Auto-start if under concurrent limit
    const running = get().getRunningOperations();
    if (running.length < get().maxConcurrent) {
      // The actual execution will be handled by the component using this store
      set((state) => ({
        operations: state.operations.map((o) =>
          o.id === id ? { ...o, status: 'running' as OperationStatus, startedAt: Date.now() } : o
        ),
      }));
    }

    return id;
  },

  removeOperation: (id) => {
    set((state) => ({
      operations: state.operations.filter((o) => o.id !== id),
    }));
  },

  clearCompleted: () => {
    set((state) => ({
      operations: state.operations.filter(
        (o) => o.status !== 'completed' && o.status !== 'cancelled'
      ),
    }));
  },

  startOperation: (id) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id ? { ...o, status: 'running' as OperationStatus, startedAt: Date.now() } : o
      ),
    }));
  },

  pauseOperation: (id) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id && o.status === 'running' ? { ...o, status: 'paused' as OperationStatus } : o
      ),
    }));
  },

  resumeOperation: (id) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id && o.status === 'paused' ? { ...o, status: 'running' as OperationStatus } : o
      ),
    }));
  },

  cancelOperation: (id) => {
    const op = get().operations.find((o) => o.id === id);
    if (op?.abortController) {
      op.abortController.abort();
    }
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id ? { ...o, status: 'cancelled' as OperationStatus, completedAt: Date.now() } : o
      ),
    }));
  },

  retryOperation: (id) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id && o.status === 'failed'
          ? {
              ...o,
              status: 'pending' as OperationStatus,
              error: undefined,
              failedItems: [],
              processedBytes: 0,
              processedItems: 0,
              abortController: new AbortController(),
            }
          : o
      ),
    }));

    // Auto-start if under limit
    const running = get().getRunningOperations();
    if (running.length < get().maxConcurrent) {
      get().startOperation(id);
    }
  },

  updateProgress: (id, update) => {
    set((state) => ({
      operations: state.operations.map((o) => (o.id === id ? { ...o, ...update } : o)),
    }));
  },

  setOperationStatus: (id, status, error) => {
    const operation = get().operations.find((o) => o.id === id);

    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id
          ? {
              ...o,
              status,
              error,
              completedAt:
                status === 'completed' || status === 'failed' ? Date.now() : o.completedAt,
            }
          : o
      ),
    }));

    // Trigger completion callback if registered
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const callback = get().onOperationComplete;
      if (callback && operation) {
        callback({ ...operation, status, error });
      }
    }

    // Start next pending operation if one completed
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const pending = get().getPendingOperations();
      const running = get().getRunningOperations();
      if (pending.length > 0 && running.length < get().maxConcurrent) {
        get().startOperation(pending[0].id);
      }
    }
  },

  addFailedItem: (id, path, error) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id ? { ...o, failedItems: [...o.failedItems, { path, error }] } : o
      ),
    }));
  },

  addConflict: (id, sourcePath, destPath) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id ? { ...o, conflicts: [...o.conflicts, { sourcePath, destPath }] } : o
      ),
    }));
  },

  resolveConflict: (id, resolution) => {
    set((state) => ({
      operations: state.operations.map((o) =>
        o.id === id ? { ...o, conflictResolution: resolution, conflicts: [] } : o
      ),
    }));
  },

  setMaxConcurrent: (n) => set({ maxConcurrent: Math.max(1, Math.min(5, n)) }),

  setDefaultConflictResolution: (resolution) => set({ defaultConflictResolution: resolution }),

  setShowProgressPanel: (show) => set({ showProgressPanel: show }),

  getRunningOperations: () => get().operations.filter((o) => o.status === 'running'),

  getPendingOperations: () => get().operations.filter((o) => o.status === 'pending'),

  hasActiveOperations: () =>
    get().operations.some(
      (o) => o.status === 'running' || o.status === 'pending' || o.status === 'paused'
    ),
}));

// Selectors for common patterns
export const useHasActiveOperations = () =>
  useOperationQueueStore((s) =>
    s.operations.some((o) => o.status === 'running' || o.status === 'pending')
  );

export const useShowProgressPanel = () => useOperationQueueStore((s) => s.showProgressPanel);

export const useActiveOperationsCount = () =>
  useOperationQueueStore(
    (s) => s.operations.filter((o) => o.status === 'running' || o.status === 'pending').length
  );

// Helper to format bytes
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper to format time remaining
export function formatTimeRemaining(ms: number): string {
  if (!ms || ms <= 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Helper to format speed
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
