import { useCallback, useEffect, useRef } from 'react';
import type { ViewMode } from '../components/ViewModeToggle';
import type { ToastType } from '../components/Toast';
import { useNavigationHistory } from './useNavigationHistory';

type UseNavigationHandlersOptions = {
  activeTabId: string;
  currentPath: string;
  setCurrentPath: (path: string) => void;
  setPathStack: (stack: string[]) => void;
  clearActiveSmartFolder: () => void;
  viewModeRef: React.MutableRefObject<ViewMode>;
  buildPathStackFromPath: (path: string) => string[];
  showToast: (message: string, options?: { type?: ToastType }) => string;
};

export function useNavigationHandlers({
  activeTabId,
  currentPath,
  setCurrentPath,
  setPathStack,
  clearActiveSmartFolder,
  viewModeRef,
  buildPathStackFromPath,
  showToast,
}: UseNavigationHandlersOptions) {
  const {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    goToBackIndex,
    goToForwardIndex,
    backHistory,
    forwardHistory,
    clearHistory,
  } = useNavigationHistory(activeTabId, currentPath);

  const goBackRef = useRef(goBack);
  const goForwardRef = useRef(goForward);
  const goToBackIndexRef = useRef(goToBackIndex);
  const goToForwardIndexRef = useRef(goToForwardIndex);
  const clearHistoryRef = useRef(clearHistory);
  const showToastRef = useRef(showToast);

  useEffect(() => {
    goBackRef.current = goBack;
    goForwardRef.current = goForward;
    goToBackIndexRef.current = goToBackIndex;
    goToForwardIndexRef.current = goToForwardIndex;
    clearHistoryRef.current = clearHistory;
    showToastRef.current = showToast;
  }, [goBack, goForward, goToBackIndex, goToForwardIndex, clearHistory, showToast]);

  const handleGoBack = useCallback(() => {
    const targetPath = goBackRef.current();
    if (targetPath) {
      clearActiveSmartFolder();
      setCurrentPath(targetPath);
      if (viewModeRef.current === 'column') {
        setPathStack(buildPathStackFromPath(targetPath));
      }
    }
  }, [setCurrentPath, setPathStack, clearActiveSmartFolder, viewModeRef, buildPathStackFromPath]);

  const handleGoForward = useCallback(() => {
    const targetPath = goForwardRef.current();
    if (targetPath) {
      clearActiveSmartFolder();
      setCurrentPath(targetPath);
      if (viewModeRef.current === 'column') {
        setPathStack(buildPathStackFromPath(targetPath));
      }
    }
  }, [setCurrentPath, setPathStack, clearActiveSmartFolder, viewModeRef, buildPathStackFromPath]);

  const handleGoToBackIndex = useCallback(
    (index: number) => {
      const targetPath = goToBackIndexRef.current(index);
      if (targetPath) {
        clearActiveSmartFolder();
        setCurrentPath(targetPath);
        if (viewModeRef.current === 'column') {
          setPathStack(buildPathStackFromPath(targetPath));
        }
      }
    },
    [setCurrentPath, setPathStack, clearActiveSmartFolder, viewModeRef, buildPathStackFromPath]
  );

  const handleGoToForwardIndex = useCallback(
    (index: number) => {
      const targetPath = goToForwardIndexRef.current(index);
      if (targetPath) {
        clearActiveSmartFolder();
        setCurrentPath(targetPath);
        if (viewModeRef.current === 'column') {
          setPathStack(buildPathStackFromPath(targetPath));
        }
      }
    },
    [setCurrentPath, setPathStack, clearActiveSmartFolder, viewModeRef, buildPathStackFromPath]
  );

  const handleClearHistoryFromPalette = useCallback(() => {
    clearHistoryRef.current();
    showToastRef.current('Navigation history cleared', { type: 'success' });
  }, []);

  return {
    canGoBack,
    canGoForward,
    backHistory,
    forwardHistory,
    clearHistory,
    handleGoBack,
    handleGoForward,
    handleGoToBackIndex,
    handleGoToForwardIndex,
    handleClearHistoryFromPalette,
  };
}
