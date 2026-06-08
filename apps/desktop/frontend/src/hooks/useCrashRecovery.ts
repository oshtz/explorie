/**
 * Hook for crash recovery functionality.
 *
 * Integrates the crash recovery system with React components.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { sessionManager, getRecoveryInfo, getSessionState } from '../utils/crashRecovery';
import { useFileStore } from '../store';
import { useShallow } from 'zustand/shallow';

interface RecoveryInfo {
  available: boolean;
  lastSaveAt: Date | null;
  tabCount: number;
  pendingOpCount: number;
  currentPath: string | null;
}

interface UseCrashRecoveryOptions {
  /** Callback to get current tabs */
  getTabs: () => Array<{ id: string; path: string }>;
  /** Callback to get active tab ID */
  getActiveTabId: () => string;
  /** Callback to get current path */
  getCurrentPath: () => string;
  /** Callback to restore tabs */
  onRestoreTabs?: (tabs: Array<{ id: string; path: string }>, activeId: string) => void;
  /** Callback to navigate to path */
  onNavigate?: (path: string) => void;
}

export interface UseCrashRecoveryResult {
  /** Whether recovery is available */
  recoveryAvailable: boolean;
  /** Recovery info for display */
  recoveryInfo: RecoveryInfo;
  /** Accept recovery and restore session */
  acceptRecovery: () => void;
  /** Dismiss recovery prompt */
  dismissRecovery: () => void;
  /** Whether recovery prompt has been dismissed/handled */
  recoveryHandled: boolean;
}

export function useCrashRecovery(options: UseCrashRecoveryOptions): UseCrashRecoveryResult {
  const { getTabs, getActiveTabId, getCurrentPath, onRestoreTabs, onNavigate } = options;

  const [recoveryInfo, setRecoveryInfo] = useState<RecoveryInfo>(() => getRecoveryInfo());
  const [recoveryHandled, setRecoveryHandled] = useState(false);
  const initializedRef = useRef(false);

  // Get store state for session saving
  const storeState = useFileStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
      showHidden: s.showHidden,
    }))
  );

  const latestSessionStateRef = useRef({
    getTabs,
    getActiveTabId,
    getCurrentPath,
    storeState,
  });

  useEffect(() => {
    latestSessionStateRef.current = {
      getTabs,
      getActiveTabId,
      getCurrentPath,
      storeState,
    };
  });

  // Initialize session manager
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Check recovery before initializing new session
    const info = getRecoveryInfo();
    setRecoveryInfo(info);

    // Initialize session manager with state getter
    sessionManager.initialize(() => ({
      tabs: latestSessionStateRef.current.getTabs(),
      activeTabId: latestSessionStateRef.current.getActiveTabId(),
      currentPath: latestSessionStateRef.current.getCurrentPath(),
      viewSettings: {
        viewMode: latestSessionStateRef.current.storeState.viewMode,
        sortKey: latestSessionStateRef.current.storeState.sortKey,
        sortDir: latestSessionStateRef.current.storeState.sortDir,
        showHidden: latestSessionStateRef.current.storeState.showHidden,
      },
      sidebarState: {
        favoritesExpanded: true,
        recentsExpanded: true,
        smartFoldersExpanded: true,
      },
    }));

    // Cleanup on unmount
    return () => {
      sessionManager.shutdown();
    };
  }, []); // Empty deps - only run once

  // Save session state when view settings change
  useEffect(() => {
    if (!initializedRef.current) return;

    // Debounce saves to avoid too many writes
    const timer = setTimeout(() => {
      sessionManager.saveNow();
    }, 1000);

    return () => clearTimeout(timer);
  }, [storeState.viewMode, storeState.sortKey, storeState.sortDir]);

  const acceptRecovery = useCallback(() => {
    const state = getSessionState();
    if (!state) {
      setRecoveryHandled(true);
      return;
    }

    // Restore tabs if callback provided
    if (onRestoreTabs && state.tabs.length > 0) {
      onRestoreTabs(state.tabs, state.activeTabId);
    }

    // Navigate to last path if callback provided
    if (onNavigate && state.currentPath) {
      onNavigate(state.currentPath);
    }

    // Clear the dirty flag since we've recovered
    sessionManager.dismissRecovery();
    setRecoveryHandled(true);
  }, [onRestoreTabs, onNavigate]);

  const dismissRecovery = useCallback(() => {
    sessionManager.dismissRecovery();
    setRecoveryHandled(true);
  }, []);

  return {
    recoveryAvailable: recoveryInfo.available && !recoveryHandled,
    recoveryInfo,
    acceptRecovery,
    dismissRecovery,
    recoveryHandled,
  };
}
