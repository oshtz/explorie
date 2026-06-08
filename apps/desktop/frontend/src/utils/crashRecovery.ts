/**
 * Crash Recovery Utility
 *
 * Handles session state persistence and recovery after unexpected terminations.
 * Uses localStorage to track session state and detect abnormal exits.
 */

const SESSION_STATE_KEY = 'explorie:sessionState';
const SESSION_DIRTY_KEY = 'explorie:sessionDirty';
const AUTOSAVE_INTERVAL_MS = 30_000; // Save session state every 30 seconds

export interface SessionState {
  /** Timestamp when session started */
  startedAt: number;
  /** Timestamp of last autosave */
  lastSaveAt: number;
  /** Currently open tabs */
  tabs: Array<{ id: string; path: string }>;
  /** Active tab ID */
  activeTabId: string;
  /** Current path in active tab */
  currentPath: string;
  /** Sidebar collapsed sections */
  sidebarState: {
    favoritesExpanded: boolean;
    recentsExpanded: boolean;
    smartFoldersExpanded: boolean;
  };
  /** View settings for quick restore */
  viewSettings: {
    viewMode: string;
    sortKey: string;
    sortDir: string;
    showHidden: boolean;
  };
  /** Pending operations that were interrupted (optional recovery info) */
  pendingOperations?: Array<{
    id: string;
    type: string;
    status: string;
    paths: string[];
    destination?: string;
  }>;
}

function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get stored session state
 */
export function getSessionState(): SessionState | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/**
 * Save session state
 */
export function saveSessionState(state: Partial<SessionState>): boolean {
  if (!isStorageAvailable()) return false;
  try {
    const existing = getSessionState();
    const merged: SessionState = {
      startedAt: existing?.startedAt ?? Date.now(),
      lastSaveAt: Date.now(),
      tabs: state.tabs ?? existing?.tabs ?? [],
      activeTabId: state.activeTabId ?? existing?.activeTabId ?? '',
      currentPath: state.currentPath ?? existing?.currentPath ?? '',
      sidebarState: state.sidebarState ??
        existing?.sidebarState ?? {
          favoritesExpanded: true,
          recentsExpanded: true,
          smartFoldersExpanded: true,
        },
      viewSettings: state.viewSettings ??
        existing?.viewSettings ?? {
          viewMode: 'list',
          sortKey: 'name',
          sortDir: 'asc',
          showHidden: false,
        },
      pendingOperations: state.pendingOperations ?? existing?.pendingOperations,
    };
    window.localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(merged));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear session state (call on clean shutdown)
 */
export function clearSessionState(): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(SESSION_STATE_KEY);
    window.localStorage.removeItem(SESSION_DIRTY_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark session as dirty (started but not cleanly terminated)
 */
export function markSessionDirty(): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(SESSION_DIRTY_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark session as clean (about to terminate cleanly)
 */
export function markSessionClean(): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(SESSION_DIRTY_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if previous session ended abnormally
 */
export function wasSessionDirty(): boolean {
  if (!isStorageAvailable()) return false;
  try {
    const dirty = window.localStorage.getItem(SESSION_DIRTY_KEY);
    return dirty !== null;
  } catch {
    return false;
  }
}

/**
 * Get timestamp of when session became dirty (if applicable)
 */
export function getDirtyTimestamp(): number | null {
  if (!isStorageAvailable()) return null;
  try {
    const dirty = window.localStorage.getItem(SESSION_DIRTY_KEY);
    if (!dirty) return null;
    const ts = parseInt(dirty, 10);
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

/**
 * Check if recovery is available and worthwhile
 */
export function canRecover(): boolean {
  const state = getSessionState();
  const dirty = wasSessionDirty();

  // Only offer recovery if session was dirty and we have meaningful state
  if (!dirty || !state) return false;

  // Check if state is not too old (within 24 hours)
  const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
  const age = Date.now() - state.lastSaveAt;
  if (age > MAX_RECOVERY_AGE_MS) return false;

  // Check if there's actually something to recover
  const hasTabs = state.tabs.length > 0;
  const hasPendingOps = (state.pendingOperations?.length ?? 0) > 0;

  return hasTabs || hasPendingOps;
}

/**
 * Get recovery info for display to user
 */
export function getRecoveryInfo(): {
  available: boolean;
  lastSaveAt: Date | null;
  tabCount: number;
  pendingOpCount: number;
  currentPath: string | null;
} {
  const state = getSessionState();
  const canRecover_ = canRecover();

  return {
    available: canRecover_,
    lastSaveAt: state?.lastSaveAt ? new Date(state.lastSaveAt) : null,
    tabCount: state?.tabs.length ?? 0,
    pendingOpCount: state?.pendingOperations?.length ?? 0,
    currentPath: state?.currentPath ?? null,
  };
}

// ============================================================================
// Session Manager Class
// ============================================================================

export class SessionManager {
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private getStateCallback: (() => Partial<SessionState>) | null = null;
  private isInitialized = false;

  /**
   * Initialize session tracking.
   * Call this early in app startup.
   */
  initialize(getState: () => Partial<SessionState>): void {
    if (this.isInitialized) return;
    this.isInitialized = true;
    this.getStateCallback = getState;

    // Mark session as dirty immediately
    markSessionDirty();

    // Save initial state
    const state = getState();
    saveSessionState({
      ...state,
      startedAt: Date.now(),
    });

    // Start autosave timer
    this.autosaveTimer = setInterval(() => {
      this.saveNow();
    }, AUTOSAVE_INTERVAL_MS);

    // Clean up on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
      window.addEventListener('pagehide', this.handlePageHide);
    }
  }

  /**
   * Save session state immediately
   */
  saveNow(): void {
    if (!this.getStateCallback) return;
    const state = this.getStateCallback();
    saveSessionState(state);
  }

  /**
   * Handle clean shutdown
   */
  shutdown(): void {
    if (!this.isInitialized) return;

    // Stop autosave
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }

    // Save final state and mark clean
    this.saveNow();
    markSessionClean();

    // Remove event listeners
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
      window.removeEventListener('pagehide', this.handlePageHide);
    }

    this.isInitialized = false;
  }

  private handleBeforeUnload = (): void => {
    this.saveNow();
    markSessionClean();
  };

  private handlePageHide = (): void => {
    this.saveNow();
    markSessionClean();
  };

  /**
   * Dismiss recovery (user chose not to recover)
   */
  dismissRecovery(): void {
    clearSessionState();
  }
}

// Default singleton instance
export const sessionManager = new SessionManager();
