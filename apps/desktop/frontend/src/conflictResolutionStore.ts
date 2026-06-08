/**
 * Global store for managing file conflict resolution during copy/move operations.
 * Provides a queue-based system for handling multiple conflicts with "apply to all" support.
 */
import { create } from 'zustand';
import { stat } from '@tauri-apps/plugin-fs';
import { fileExists, joinPaths } from './utils/fs';
import { basename } from './utils/path';

export type ConflictAction = 'skip' | 'replace' | 'keepBoth';

export interface ConflictInfo {
  /** Source file path */
  sourcePath: string;
  /** Source file name */
  sourceName: string;
  /** Source file size in bytes */
  sourceSize?: number;
  /** Source file modified date */
  sourceModified?: Date;
  /** Whether source is a directory */
  sourceIsDir: boolean;
  /** Destination file path */
  destPath: string;
  /** Destination file name */
  destName: string;
  /** Destination file size in bytes */
  destSize?: number;
  /** Destination file modified date */
  destModified?: Date;
  /** Whether destination is a directory */
  destIsDir: boolean;
}

interface PendingConflict {
  conflict: ConflictInfo;
  resolve: (action: ConflictAction) => void;
}

interface ConflictResolutionState {
  /** Queue of pending conflicts */
  conflicts: PendingConflict[];
  /** Current conflict index */
  currentIndex: number;
  /** Operation type */
  operationType: 'copy' | 'move';
  /** Whether the dialog should be visible */
  isOpen: boolean;
  /** "Apply to all" action if set */
  applyToAllAction: ConflictAction | null;

  // Actions
  /** Queue a new conflict for resolution */
  queueConflict: (conflict: ConflictInfo) => Promise<ConflictAction>;
  /** Resolve the current conflict */
  resolveConflict: (action: ConflictAction, applyToAll: boolean) => void;
  /** Cancel all pending conflicts */
  cancelAll: () => void;
  /** Reset state for a new operation */
  reset: (operationType: 'copy' | 'move') => void;
  /** Set operation type */
  setOperationType: (type: 'copy' | 'move') => void;

  // Computed
  /** Get current conflict being resolved */
  getCurrentConflict: () => ConflictInfo | null;
  /** Get total number of conflicts */
  getTotalConflicts: () => number;
}

export const useConflictResolutionStore = create<ConflictResolutionState>((set, get) => ({
  conflicts: [],
  currentIndex: 0,
  operationType: 'copy',
  isOpen: false,
  applyToAllAction: null,

  queueConflict: (conflict: ConflictInfo): Promise<ConflictAction> => {
    // If "apply to all" was set, return that action immediately
    const applyToAll = get().applyToAllAction;
    if (applyToAll !== null) {
      return Promise.resolve(applyToAll);
    }

    return new Promise<ConflictAction>((resolve) => {
      const pending: PendingConflict = { conflict, resolve };

      set((state) => ({
        conflicts: [...state.conflicts, pending],
        isOpen: true,
      }));
    });
  },

  resolveConflict: (action: ConflictAction, applyToAll: boolean) => {
    const state = get();

    if (applyToAll) {
      // Store the action and resolve all pending conflicts
      set({ applyToAllAction: action });

      state.conflicts.forEach((pending) => {
        pending.resolve(action);
      });

      set({
        conflicts: [],
        currentIndex: 0,
        isOpen: false,
      });
    } else {
      // Resolve only the current conflict
      const current = state.conflicts[state.currentIndex];
      if (current) {
        current.resolve(action);
      }

      if (state.currentIndex >= state.conflicts.length - 1) {
        // Last conflict - close dialog
        set({
          conflicts: [],
          currentIndex: 0,
          isOpen: false,
        });
      } else {
        // Move to next conflict
        set({ currentIndex: state.currentIndex + 1 });
      }
    }
  },

  cancelAll: () => {
    const state = get();

    // Resolve all as 'skip' to cancel
    state.conflicts.forEach((pending) => {
      pending.resolve('skip');
    });

    set({
      conflicts: [],
      currentIndex: 0,
      isOpen: false,
      applyToAllAction: null,
    });
  },

  reset: (operationType: 'copy' | 'move') => {
    set({
      conflicts: [],
      currentIndex: 0,
      operationType,
      isOpen: false,
      applyToAllAction: null,
    });
  },

  setOperationType: (type: 'copy' | 'move') => {
    set({ operationType: type });
  },

  getCurrentConflict: () => {
    const state = get();
    return state.conflicts[state.currentIndex]?.conflict ?? null;
  },

  getTotalConflicts: () => {
    return get().conflicts.length;
  },
}));

/**
 * Check if a file exists at the destination and create conflict info.
 * Returns null if no conflict exists.
 */
export async function checkForConflict(
  sourcePath: string,
  destDir: string,
  isDir: boolean
): Promise<ConflictInfo | null> {
  const name = basename(sourcePath);
  const destPath = joinPaths(destDir, name);

  const exists = await fileExists(destPath);
  if (!exists) return null;

  // Get file info for both source and destination
  let sourceSize: number | undefined;
  let sourceModified: Date | undefined;
  let destSize: number | undefined;
  let destModified: Date | undefined;
  let destIsDir = false;

  try {
    const sourceStat = await stat(sourcePath);
    sourceSize = sourceStat.size;
    sourceModified = sourceStat.mtime ? new Date(sourceStat.mtime) : undefined;
  } catch {
    // Ignore stat errors
  }

  try {
    const destStat = await stat(destPath);
    destSize = destStat.size;
    destModified = destStat.mtime ? new Date(destStat.mtime) : undefined;
    destIsDir = destStat.isDirectory;
  } catch {
    // Ignore stat errors
  }

  return {
    sourcePath,
    sourceName: name,
    sourceSize,
    sourceModified,
    sourceIsDir: isDir,
    destPath,
    destName: name,
    destSize,
    destModified,
    destIsDir,
  };
}

// Selectors
export const useIsConflictDialogOpen = () => useConflictResolutionStore((s) => s.isOpen);

export const useCurrentConflict = () =>
  useConflictResolutionStore((s) => s.conflicts[s.currentIndex]?.conflict ?? null);

export const useConflictOperationType = () => useConflictResolutionStore((s) => s.operationType);

export const useConflictProgress = () => {
  const currentIndex = useConflictResolutionStore((s) => s.currentIndex);
  const total = useConflictResolutionStore((s) => s.conflicts.length);
  return {
    current: currentIndex + 1,
    total,
  };
};
