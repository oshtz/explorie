import { useState, useCallback, useEffect, useRef } from 'react';

export interface NavigationHistory {
  past: string[];
  future: string[];
}

interface UseNavigationHistoryReturn {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => string | null;
  goForward: () => string | null;
  /** Navigate to a specific index in back history (0 = most recent) */
  goToBackIndex: (index: number) => string | null;
  /** Navigate to a specific index in forward history (0 = next) */
  goToForwardIndex: (index: number) => string | null;
  pushPath: (path: string) => void;
  /** Call when navigating programmatically (not via back/forward) to clear future */
  onNavigate: (path: string) => void;
  /** Back history stack (most recent at end) */
  backHistory: string[];
  /** Forward history stack (next at start) */
  forwardHistory: string[];
  /** Clear all navigation history for this tab */
  clearHistory: () => void;
}

const MAX_HISTORY_SIZE = 50;

function loadHistory(tabId: string): NavigationHistory {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(`explorie:history:${tabId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.past) && Array.isArray(parsed.future)) {
          return {
            past: parsed.past.slice(-MAX_HISTORY_SIZE),
            future: parsed.future.slice(0, MAX_HISTORY_SIZE),
          };
        }
      }
    }
  } catch {}
  return { past: [], future: [] };
}

function saveHistory(tabId: string, history: NavigationHistory): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(`explorie:history:${tabId}`, JSON.stringify(history));
    }
  } catch {}
}

/**
 * Hook for managing navigation history per tab.
 * Each tab has its own back/forward stack.
 */
export function useNavigationHistory(
  tabId: string,
  currentPath: string
): UseNavigationHistoryReturn {
  const [history, setHistory] = useState<NavigationHistory>(() => loadHistory(tabId));

  // Track last known path to detect external navigation
  const lastPathRef = useRef<string>(currentPath);
  const currentPathRef = useRef<string>(currentPath);
  // Flag to skip recording when we're navigating via back/forward
  const isNavigatingRef = useRef<boolean>(false);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // Persist history when it changes
  useEffect(() => {
    saveHistory(tabId, history);
  }, [tabId, history]);

  // Reload history when tab changes
  useEffect(() => {
    const loaded = loadHistory(tabId);
    setHistory(loaded);
    lastPathRef.current = currentPathRef.current;
  }, [tabId]);

  // Track path changes that come from normal navigation (not back/forward)
  useEffect(() => {
    if (isNavigatingRef.current) {
      // This path change was triggered by goBack/goForward, don't record
      isNavigatingRef.current = false;
      lastPathRef.current = currentPath;
      return;
    }

    const prevPath = lastPathRef.current;
    if (prevPath && prevPath !== currentPath) {
      // Normal navigation: push previous path to history, clear future
      setHistory((prev) => ({
        past: [...prev.past.slice(-(MAX_HISTORY_SIZE - 1)), prevPath],
        future: [], // Clear forward history on new navigation
      }));
    }
    lastPathRef.current = currentPath;
  }, [currentPath]);

  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;

  const goBack = useCallback((): string | null => {
    if (history.past.length === 0) return null;

    const newPast = [...history.past];
    const targetPath = newPast.pop()!;

    // Mark that we're navigating programmatically
    isNavigatingRef.current = true;

    setHistory({
      past: newPast,
      future: [currentPath, ...history.future].slice(0, MAX_HISTORY_SIZE),
    });

    return targetPath;
  }, [history, currentPath]);

  const goForward = useCallback((): string | null => {
    if (history.future.length === 0) return null;

    const newFuture = [...history.future];
    const targetPath = newFuture.shift()!;

    // Mark that we're navigating programmatically
    isNavigatingRef.current = true;

    setHistory({
      past: [...history.past, currentPath].slice(-MAX_HISTORY_SIZE),
      future: newFuture,
    });

    return targetPath;
  }, [history, currentPath]);

  const pushPath = useCallback(
    (path: string) => {
      if (path === currentPath) return;
      setHistory((prev) => ({
        past: [...prev.past.slice(-(MAX_HISTORY_SIZE - 1)), currentPath],
        future: [],
      }));
    },
    [currentPath]
  );

  const goToBackIndex = useCallback(
    (index: number): string | null => {
      // index 0 = most recent (end of past array)
      const actualIndex = history.past.length - 1 - index;
      if (actualIndex < 0 || actualIndex >= history.past.length) return null;

      const targetPath = history.past[actualIndex];

      // Mark that we're navigating programmatically
      isNavigatingRef.current = true;

      // Everything after actualIndex goes to future (including current path)
      const newPast = history.past.slice(0, actualIndex);
      const skippedPaths = history.past.slice(actualIndex + 1);

      setHistory({
        past: newPast,
        future: [...skippedPaths, currentPath, ...history.future].slice(0, MAX_HISTORY_SIZE),
      });

      return targetPath;
    },
    [history, currentPath]
  );

  const goToForwardIndex = useCallback(
    (index: number): string | null => {
      if (index < 0 || index >= history.future.length) return null;

      const targetPath = history.future[index];

      // Mark that we're navigating programmatically
      isNavigatingRef.current = true;

      // Everything before index goes to past (including current path)
      const skippedPaths = history.future.slice(0, index);
      const newFuture = history.future.slice(index + 1);

      setHistory({
        past: [...history.past, currentPath, ...skippedPaths].slice(-MAX_HISTORY_SIZE),
        future: newFuture,
      });

      return targetPath;
    },
    [history, currentPath]
  );

  const onNavigate = useCallback((_path: string) => {
    // Called when navigating normally - handled by useEffect watching currentPath
    // This is a no-op but provides explicit API for clarity
  }, []);

  const clearHistory = useCallback(() => {
    setHistory({ past: [], future: [] });
    // Also clear from localStorage
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(`explorie:history:${tabId}`);
      }
    } catch {}
  }, [tabId]);

  return {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    goToBackIndex,
    goToForwardIndex,
    pushPath,
    onNavigate,
    backHistory: history.past,
    forwardHistory: history.future,
    clearHistory,
  };
}
