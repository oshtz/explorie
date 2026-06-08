/**
 * Undo/Redo system for file operations.
 * Uses a stack-based approach with operation objects that know how to undo/redo themselves.
 */
import { create } from 'zustand';

// Operation types
export type OperationType = 'delete' | 'rename' | 'move' | 'copy' | 'create' | 'batch_rename';

// Base operation interface
export interface BaseOperation {
  id: string;
  type: OperationType;
  timestamp: number;
  description: string;
  /** Approximate memory footprint for undo/redo bookkeeping */
  memoryBytes?: number;
  // Undo and redo functions return success status
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
}

// Delete operation - stores file metadata for undo messaging
export interface DeleteOperation extends BaseOperation {
  type: 'delete';
  // Store paths and whether they were directories for display
  deletedItems: Array<{
    path: string;
    name: string;
    isDir: boolean;
  }>;
  // Store trash paths so delete can be undone.
  backups?: Array<{
    originalPath: string;
    trashPath: string;
    name: string;
    isDir: boolean;
  }>;
  // For actual undo, we need to store the files in a temp location
  // This is the reference to where the backup is stored
  backupId?: string;
}

// Rename operation
export interface RenameOperation extends BaseOperation {
  type: 'rename';
  oldPath: string;
  newPath: string;
  oldName: string;
  newName: string;
  /** Modification time of the file when rename occurred (for conflict detection) */
  originalModified?: number;
}

// Move operation
export interface MoveOperation extends BaseOperation {
  type: 'move';
  items: Array<{
    sourcePath: string;
    destPath: string;
    name: string;
    /** Modification time when move occurred */
    originalModified?: number;
  }>;
}

// Copy operation - we store paths of created copies so we can delete them on undo
export interface CopyOperation extends BaseOperation {
  type: 'copy';
  createdPaths: string[];
  /** Store creation times of copied files for conflict detection */
  createdTimestamps?: number[];
  sourceItems: Array<{
    path: string;
    name: string;
  }>;
}

// Create operation (new folder, new file)
export interface CreateOperation extends BaseOperation {
  type: 'create';
  createdPath: string;
  itemType: 'folder' | 'file';
  name: string;
  // For files, store content so we can recreate on redo
  content?: string;
  /** Creation time of the file/folder for conflict detection */
  createdTimestamp?: number;
}

// Batch rename operation - stores all individual rename mappings
export interface BatchRenameOperation extends BaseOperation {
  type: 'batch_rename';
  /** List of renames with old and new paths */
  renames: Array<{
    oldPath: string;
    newPath: string;
    oldName: string;
    newName: string;
    /** Modification time when rename occurred */
    originalModified?: number;
  }>;
  /** Number of files successfully renamed (for display) */
  successCount: number;
}

export type Operation =
  | DeleteOperation
  | RenameOperation
  | MoveOperation
  | CopyOperation
  | CreateOperation
  | BatchRenameOperation;

// Validation result for undo operations
export type UndoValidationResult = {
  valid: boolean;
  reason?: 'expired' | 'file_modified' | 'file_missing' | 'file_exists' | 'unknown';
  message?: string;
};

/**
 * Helper function to create a validation result.
 */
export function createValidationResult(
  valid: boolean,
  reason?: UndoValidationResult['reason'],
  message?: string
): UndoValidationResult {
  return { valid, reason, message };
}

// Store state
interface UndoRedoState {
  undoStack: Operation[];
  redoStack: Operation[];
  maxStackSize: number;
  maxStackBytes: number;
  /** Operation timeout in milliseconds (default: 5 minutes) */
  operationTimeoutMs: number;
  isProcessing: boolean;

  // Actions
  push: (operation: Operation) => void;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  clear: () => void;
  clearRedo: () => void;
  /** Remove operations older than the timeout threshold */
  pruneExpiredOperations: () => void;
  /** Set the operation timeout in minutes */
  setOperationTimeout: (minutes: number) => void;

  // Computed
  canUndo: () => boolean;
  canRedo: () => boolean;
  getLastUndo: () => Operation | undefined;
  getLastRedo: () => Operation | undefined;
  /** Check if an operation is still within the timeout window */
  isOperationValid: (operation: Operation) => boolean;
  /** Get time remaining for an operation in seconds */
  getOperationTimeRemaining: (operation: Operation) => number;
  /** Validate an operation can be undone (checks expiration, file conflicts) */
  validateOperation: (operation: Operation) => UndoValidationResult;
}

let operationIdCounter = 0;

export function generateOperationId(): string {
  return `op-${Date.now()}-${++operationIdCounter}`;
}

// Default timeout: 5 minutes
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STACK_BYTES = 24 * 1024 * 1024;

const estimateStringBytes = (value?: string): number =>
  typeof value === 'string' ? value.length : 0;

const estimateStringArrayBytes = (values?: string[]): number =>
  Array.isArray(values) ? values.reduce((sum, value) => sum + value.length, 0) : 0;

function estimateOperationBytes(operation: Operation): number {
  let total = estimateStringBytes(operation.description);
  switch (operation.type) {
    case 'delete': {
      total += operation.deletedItems.reduce(
        (sum, item) => sum + estimateStringBytes(item.path) + estimateStringBytes(item.name),
        0
      );
      if (operation.backups) {
        total += operation.backups.reduce(
          (sum, item) =>
            sum +
            estimateStringBytes(item.originalPath) +
            estimateStringBytes(item.trashPath) +
            estimateStringBytes(item.name),
          0
        );
      }
      return total;
    }
    case 'rename':
      return (
        total +
        estimateStringBytes(operation.oldPath) +
        estimateStringBytes(operation.newPath) +
        estimateStringBytes(operation.oldName) +
        estimateStringBytes(operation.newName)
      );
    case 'move':
      return (
        total +
        operation.items.reduce(
          (sum, item) =>
            sum +
            estimateStringBytes(item.sourcePath) +
            estimateStringBytes(item.destPath) +
            estimateStringBytes(item.name),
          0
        )
      );
    case 'copy':
      return (
        total +
        estimateStringArrayBytes(operation.createdPaths) +
        operation.sourceItems.reduce(
          (sum, item) => sum + estimateStringBytes(item.path) + estimateStringBytes(item.name),
          0
        )
      );
    case 'create':
      return (
        total +
        estimateStringBytes(operation.createdPath) +
        estimateStringBytes(operation.name) +
        estimateStringBytes(operation.content)
      );
    case 'batch_rename':
      return (
        total +
        operation.renames.reduce(
          (sum, item) =>
            sum +
            estimateStringBytes(item.oldPath) +
            estimateStringBytes(item.newPath) +
            estimateStringBytes(item.oldName) +
            estimateStringBytes(item.newName),
          0
        )
      );
    default:
      return total;
  }
}

function ensureOperationBytes(operation: Operation): Operation {
  if (operation.memoryBytes != null) return operation;
  return { ...operation, memoryBytes: estimateOperationBytes(operation) };
}

function getOperationBytes(operation: Operation): number {
  return operation.memoryBytes ?? estimateOperationBytes(operation);
}

function trimStackByLimits(stack: Operation[], maxSize: number, maxBytes: number): Operation[] {
  const trimmed = [...stack];
  while (trimmed.length > maxSize) {
    trimmed.shift();
  }
  let totalBytes = trimmed.reduce((sum, op) => sum + getOperationBytes(op), 0);
  while (totalBytes > maxBytes && trimmed.length > 0) {
    const removed = trimmed.shift();
    if (removed) {
      totalBytes = Math.max(0, totalBytes - getOperationBytes(removed));
    }
  }
  return trimmed;
}

// Load timeout from localStorage
function loadOperationTimeout(): number {
  try {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('explorie:undoTimeoutMinutes');
      if (saved) {
        const minutes = parseInt(saved, 10);
        if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 60) {
          return minutes * 60 * 1000;
        }
      }
    }
  } catch {}
  return DEFAULT_TIMEOUT_MS;
}

export const useUndoRedoStore = create<UndoRedoState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  maxStackSize: 50,
  maxStackBytes: DEFAULT_MAX_STACK_BYTES,
  operationTimeoutMs: loadOperationTimeout(),
  isProcessing: false,

  push: (operation: Operation) => {
    set((state) => {
      const nextOperation = ensureOperationBytes(operation);
      const newStack = trimStackByLimits(
        [...state.undoStack, nextOperation],
        state.maxStackSize,
        state.maxStackBytes
      );
      return {
        undoStack: newStack,
        redoStack: [], // Clear redo stack on new operation
      };
    });
  },

  undo: async () => {
    const state = get();
    if (state.isProcessing || state.undoStack.length === 0) {
      return false;
    }

    // First, prune expired operations
    get().pruneExpiredOperations();

    // Check again after pruning
    const currentState = get();
    if (currentState.undoStack.length === 0) {
      return false;
    }

    set({ isProcessing: true });

    try {
      const operation = currentState.undoStack[currentState.undoStack.length - 1];

      // Check if operation has expired
      if (!get().isOperationValid(operation)) {
        // Remove expired operation and return false
        set((s) => ({
          undoStack: s.undoStack.slice(0, -1),
        }));
        return false;
      }

      const success = await operation.undo();

      if (success) {
        set((s) => {
          const updatedUndo = s.undoStack.slice(0, -1);
          const updatedRedo = trimStackByLimits(
            [...s.redoStack, ensureOperationBytes(operation)],
            s.maxStackSize,
            s.maxStackBytes
          );
          return {
            undoStack: updatedUndo,
            redoStack: updatedRedo,
          };
        });
      }

      return success;
    } catch (error) {
      console.error('Undo failed:', error);
      return false;
    } finally {
      set({ isProcessing: false });
    }
  },

  redo: async () => {
    const state = get();
    if (state.isProcessing || state.redoStack.length === 0) {
      return false;
    }

    set({ isProcessing: true });

    try {
      const operation = state.redoStack[state.redoStack.length - 1];
      const success = await operation.redo();

      if (success) {
        set((s) => {
          const updatedRedo = s.redoStack.slice(0, -1);
          const updatedUndo = trimStackByLimits(
            [...s.undoStack, ensureOperationBytes(operation)],
            s.maxStackSize,
            s.maxStackBytes
          );
          return {
            redoStack: updatedRedo,
            undoStack: updatedUndo,
          };
        });
      }

      return success;
    } catch (error) {
      console.error('Redo failed:', error);
      return false;
    } finally {
      set({ isProcessing: false });
    }
  },

  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
    });
  },

  clearRedo: () => {
    set({ redoStack: [] });
  },

  pruneExpiredOperations: () => {
    const now = Date.now();
    const timeoutMs = get().operationTimeoutMs;

    set((state) => {
      const filteredUndo = state.undoStack.filter((op) => now - op.timestamp < timeoutMs);
      return {
        undoStack: trimStackByLimits(filteredUndo, state.maxStackSize, state.maxStackBytes),
        // Keep redo stack as-is since user explicitly performed undo
      };
    });
  },

  setOperationTimeout: (minutes: number) => {
    const clampedMinutes = Math.min(60, Math.max(1, minutes));
    const timeoutMs = clampedMinutes * 60 * 1000;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:undoTimeoutMinutes', String(clampedMinutes));
      }
    } catch {}
    set({ operationTimeoutMs: timeoutMs });
  },

  canUndo: () => {
    const state = get();
    if (state.isProcessing || state.undoStack.length === 0) return false;
    // Check if the most recent operation is still valid
    const lastOp = state.undoStack[state.undoStack.length - 1];
    return state.isOperationValid(lastOp);
  },
  canRedo: () => get().redoStack.length > 0 && !get().isProcessing,
  getLastUndo: () => {
    const state = get();
    // Return the last valid operation
    for (let i = state.undoStack.length - 1; i >= 0; i--) {
      if (state.isOperationValid(state.undoStack[i])) {
        return state.undoStack[i];
      }
    }
    return undefined;
  },
  getLastRedo: () => get().redoStack[get().redoStack.length - 1],

  isOperationValid: (operation: Operation) => {
    const now = Date.now();
    const timeoutMs = get().operationTimeoutMs;
    return now - operation.timestamp < timeoutMs;
  },

  getOperationTimeRemaining: (operation: Operation) => {
    const now = Date.now();
    const timeoutMs = get().operationTimeoutMs;
    const elapsed = now - operation.timestamp;
    const remaining = timeoutMs - elapsed;
    return Math.max(0, Math.floor(remaining / 1000));
  },

  validateOperation: (operation: Operation) => {
    // Check if operation has expired
    if (!get().isOperationValid(operation)) {
      const timeoutMinutes = Math.round(get().operationTimeoutMs / 60000);
      return createValidationResult(
        false,
        'expired',
        `Operation expired (undo only available for ${timeoutMinutes} minutes)`
      );
    }

    // For operations that track modification times, the actual validation
    // happens in the undo() function itself since it requires async file system checks.
    // Here we just do basic validation.

    switch (operation.type) {
      case 'rename': {
        // Basic check: the new path should exist for undo to work
        return createValidationResult(true);
      }
      case 'move': {
        // Basic check: items should be at destination for undo to work
        return createValidationResult(true);
      }
      case 'copy': {
        // Basic check: copied files should exist for undo (delete) to work
        return createValidationResult(true);
      }
      case 'create': {
        // Basic check: created item should exist for undo (delete) to work
        return createValidationResult(true);
      }
      case 'delete': {
        // Delete operations are special - we can't fully restore deleted files
        // unless we have a backup. The undo function handles this warning.
        return createValidationResult(true);
      }
      case 'batch_rename': {
        // Basic check: all renamed files should exist at new paths for undo to work
        return createValidationResult(true);
      }
      default:
        return createValidationResult(true);
    }
  },
}));

// Helper to subscribe to undo/redo availability changes
export function useCanUndo() {
  return useUndoRedoStore((s) => {
    if (s.isProcessing || s.undoStack.length === 0) return false;
    // Check if the most recent operation is still valid
    const lastOp = s.undoStack[s.undoStack.length - 1];
    const now = Date.now();
    return now - lastOp.timestamp < s.operationTimeoutMs;
  });
}

export function useCanRedo() {
  return useUndoRedoStore((s) => s.redoStack.length > 0 && !s.isProcessing);
}

/**
 * Hook that returns the time remaining (in seconds) for the most recent undo operation.
 * Returns null if no valid undo operation exists.
 */
export function useUndoTimeRemaining(): number | null {
  const lastOp = useUndoRedoStore((s) => s.undoStack[s.undoStack.length - 1]);
  const timeoutMs = useUndoRedoStore((s) => s.operationTimeoutMs);

  if (!lastOp) return null;

  const now = Date.now();
  const elapsed = now - lastOp.timestamp;
  const remaining = timeoutMs - elapsed;

  if (remaining <= 0) return null;
  return Math.floor(remaining / 1000);
}

type UndoExpirationWindow = Window &
  typeof globalThis & {
    __undoPruneInterval?: ReturnType<typeof setInterval>;
  };

/**
 * Hook to set up automatic pruning of expired operations.
 * Call this once at the app level.
 */
export function useUndoExpiration() {
  // Set up interval to prune expired operations every 30 seconds
  if (typeof window !== 'undefined') {
    // Use a module-level variable to avoid multiple intervals
    const undoWindow = window as UndoExpirationWindow;
    if (!undoWindow.__undoPruneInterval) {
      undoWindow.__undoPruneInterval = setInterval(() => {
        useUndoRedoStore.getState().pruneExpiredOperations();
      }, 30000);
    }
  }
}
