import { useEffect } from 'react';
import type { ViewMode } from '../components/ViewModeToggle';

export interface UseAppKeyboardShortcutsInput {
  activeTabId: string;
  currentPath: string;
  selectedFileIsPreviewable: boolean;
  isQuickLookOpen: boolean;
  viewMode: ViewMode;
  canUndo: boolean;
  canRedo: boolean;
  addTab: () => void;
  closeTab: (tabId: string) => void;
  goBack: () => void;
  goForward: () => void;
  openQuickLook: () => void | boolean;
  openGoToFolder: () => void;
  openCommandPalette: () => void;
  toggleDebugPanel: () => void;
  addFavorite: (path: string) => void;
  toggleShortcutsOverlay: () => void;
  undo: () => void | boolean | Promise<void | boolean>;
  redo: () => void | boolean | Promise<void | boolean>;
  increaseThumbnailSize: () => void;
  decreaseThumbnailSize: () => void;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function useAppKeyboardShortcuts({
  activeTabId,
  currentPath,
  selectedFileIsPreviewable,
  isQuickLookOpen,
  viewMode,
  canUndo,
  canRedo,
  addTab,
  closeTab,
  goBack,
  goForward,
  openQuickLook,
  openGoToFolder,
  openCommandPalette,
  toggleDebugPanel,
  addFavorite,
  toggleShortcutsOverlay,
  undo,
  redo,
  increaseThumbnailSize,
  decreaseThumbnailSize,
}: UseAppKeyboardShortcutsInput): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const isInputField = isEditableShortcutTarget(event.target);

      if (ctrlOrMeta && (event.key === 't' || event.key === 'T')) {
        event.preventDefault();
        addTab();
        return;
      }

      if (ctrlOrMeta && (event.key === 'w' || event.key === 'W')) {
        event.preventDefault();
        closeTab(activeTabId);
        return;
      }

      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
        return;
      }

      if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        goForward();
        return;
      }

      if (event.key === ' ' && !isInputField && !isQuickLookOpen && selectedFileIsPreviewable) {
        event.preventDefault();
        openQuickLook();
        return;
      }

      if (ctrlOrMeta && (event.key === 'g' || event.key === 'G') && !isInputField) {
        event.preventDefault();
        openGoToFolder();
        return;
      }

      if (ctrlOrMeta && event.shiftKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        openCommandPalette();
        return;
      }

      if (ctrlOrMeta && event.shiftKey && (event.key === 'd' || event.key === 'D')) {
        event.preventDefault();
        toggleDebugPanel();
        return;
      }

      if (ctrlOrMeta && (event.key === 'd' || event.key === 'D') && !isInputField) {
        event.preventDefault();
        if (currentPath) addFavorite(currentPath);
        return;
      }

      if (event.key === '?' && !isInputField && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        toggleShortcutsOverlay();
        return;
      }

      if (
        ctrlOrMeta &&
        (event.key === 'z' || event.key === 'Z') &&
        !event.shiftKey &&
        !isInputField
      ) {
        event.preventDefault();
        if (canUndo) void undo();
        return;
      }

      if (
        ctrlOrMeta &&
        (event.key === 'y' ||
          event.key === 'Y' ||
          ((event.key === 'z' || event.key === 'Z') && event.shiftKey)) &&
        !isInputField
      ) {
        event.preventDefault();
        if (canRedo) void redo();
        return;
      }

      if (
        (event.key === '+' || event.key === '=') &&
        !isInputField &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        viewMode === 'grid'
      ) {
        event.preventDefault();
        increaseThumbnailSize();
        return;
      }

      if (
        event.key === '-' &&
        !isInputField &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        viewMode === 'grid'
      ) {
        event.preventDefault();
        decreaseThumbnailSize();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activeTabId,
    addFavorite,
    addTab,
    canRedo,
    canUndo,
    closeTab,
    currentPath,
    decreaseThumbnailSize,
    goBack,
    goForward,
    increaseThumbnailSize,
    isQuickLookOpen,
    openCommandPalette,
    openGoToFolder,
    openQuickLook,
    redo,
    selectedFileIsPreviewable,
    toggleDebugPanel,
    toggleShortcutsOverlay,
    undo,
    viewMode,
  ]);
}
