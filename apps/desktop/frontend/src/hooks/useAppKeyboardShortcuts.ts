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
  deleteSelection: () => void;
  goUp: () => void;
  refresh: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleHidden: () => void;
  activateTabOffset: (offset: number) => void;
  focusSearch: () => void;
  typeToSelect: (key: string) => void;
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
  deleteSelection,
  goUp,
  refresh,
  setViewMode,
  toggleHidden,
  activateTabOffset,
  focusSearch,
  typeToSelect,
}: UseAppKeyboardShortcutsInput): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;

      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const isInputField = isEditableShortcutTarget(event.target);

      if (!isInputField && event.key === 'Delete' && !ctrlOrMeta && !event.altKey) {
        event.preventDefault();
        deleteSelection();
        return;
      }

      if (!isInputField && event.key === 'Backspace' && !ctrlOrMeta && !event.altKey) {
        event.preventDefault();
        goUp();
        return;
      }

      if (!isInputField && event.key === 'F5') {
        event.preventDefault();
        refresh();
        return;
      }

      if (ctrlOrMeta && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        setViewMode(event.key === '1' ? 'list' : event.key === '2' ? 'grid' : 'column');
        return;
      }

      if (ctrlOrMeta && (event.key === 'h' || event.key === 'H') && !isInputField) {
        event.preventDefault();
        toggleHidden();
        return;
      }

      if (ctrlOrMeta && event.key === 'Tab') {
        event.preventDefault();
        activateTabOffset(event.shiftKey ? -1 : 1);
        return;
      }

      if (ctrlOrMeta && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        focusSearch();
        return;
      }

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

      if (
        import.meta.env.DEV &&
        ctrlOrMeta &&
        event.shiftKey &&
        (event.key === 'd' || event.key === 'D')
      ) {
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
        return;
      }

      if (
        !isInputField &&
        event.key.length === 1 &&
        event.key.trim().length === 1 &&
        !ctrlOrMeta &&
        !event.altKey
      ) {
        event.preventDefault();
        typeToSelect(event.key);
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
    activateTabOffset,
    deleteSelection,
    decreaseThumbnailSize,
    focusSearch,
    goBack,
    goForward,
    goUp,
    increaseThumbnailSize,
    isQuickLookOpen,
    openCommandPalette,
    openGoToFolder,
    openQuickLook,
    redo,
    refresh,
    selectedFileIsPreviewable,
    setViewMode,
    toggleDebugPanel,
    toggleShortcutsOverlay,
    toggleHidden,
    typeToSelect,
    undo,
    viewMode,
  ]);
}
