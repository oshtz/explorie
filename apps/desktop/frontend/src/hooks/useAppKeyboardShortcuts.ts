import { useEffect } from 'react';
import type { ViewMode } from '../components/ViewModeToggle';
import { useFileStore } from '../store';
import { matchShortcut, SHORTCUT_META, type ShortcutId } from '../utils/shortcuts';

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
  const shortcuts = useFileStore((state) => state.shortcuts);

  useEffect(() => {
    const run = (id: ShortcutId): boolean => {
      switch (id) {
        case 'deleteSelection':
          deleteSelection();
          return true;
        case 'goUp':
          goUp();
          return true;
        case 'refresh':
          refresh();
          return true;
        case 'viewList':
          setViewMode('list');
          return true;
        case 'viewGrid':
          setViewMode('grid');
          return true;
        case 'viewColumn':
          setViewMode('column');
          return true;
        case 'toggleHidden':
          toggleHidden();
          return true;
        case 'nextTab':
          activateTabOffset(1);
          return true;
        case 'prevTab':
          activateTabOffset(-1);
          return true;
        case 'focusSearch':
          focusSearch();
          return true;
        case 'newTab':
          addTab();
          return true;
        case 'closeTab':
          closeTab(activeTabId);
          return true;
        case 'goBack':
          goBack();
          return true;
        case 'goForward':
          goForward();
          return true;
        case 'quickLook':
          if (!isQuickLookOpen && selectedFileIsPreviewable) {
            openQuickLook();
            return true;
          }
          return false;
        case 'goToFolder':
          openGoToFolder();
          return true;
        case 'commandPalette':
          openCommandPalette();
          return true;
        case 'addFavorite':
          if (currentPath) addFavorite(currentPath);
          return true;
        case 'showShortcuts':
          toggleShortcutsOverlay();
          return true;
        case 'undo':
          if (canUndo) void undo();
          return true;
        case 'redo':
          if (canRedo) void redo();
          return true;
        case 'increaseThumbnail':
          if (viewMode === 'grid') {
            increaseThumbnailSize();
            return true;
          }
          return false;
        case 'decreaseThumbnail':
          if (viewMode === 'grid') {
            decreaseThumbnailSize();
            return true;
          }
          return false;
        default:
          return false;
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;

      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const isInputField = isEditableShortcutTarget(event.target);
      const id = matchShortcut(shortcuts, event);

      if (id) {
        if (isInputField && SHORTCUT_META[id].suppressInEditable) return;
        if (run(id)) {
          event.preventDefault();
        }
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
    shortcuts,
    toggleDebugPanel,
    toggleShortcutsOverlay,
    toggleHidden,
    typeToSelect,
    undo,
    viewMode,
  ]);
}
