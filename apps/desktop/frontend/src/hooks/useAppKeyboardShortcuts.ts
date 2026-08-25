import { useEffect } from 'react';
import type { ViewMode } from '../components/ViewModeToggle';
import {
  DEFAULT_SHORTCUTS,
  matchesShortcut,
  type ShortcutId,
  type ShortcutMap,
} from '../utils/shortcuts';

export interface UseAppKeyboardShortcutsInput {
  activeTabId: string;
  currentPath: string;
  selectedFileIsPreviewable: boolean;
  isQuickLookOpen: boolean;
  viewMode: ViewMode;
  canUndo: boolean;
  canRedo: boolean;
  shortcuts?: ShortcutMap;
  addTab: () => void;
  closeTab: (tabId: string) => void;
  goBack: () => void;
  goForward: () => void;
  openQuickLook: () => void | boolean;
  openGoToFolder: () => void;
  openSettings?: () => void;
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
  shortcuts = DEFAULT_SHORTCUTS,
  addTab,
  closeTab,
  goBack,
  goForward,
  openQuickLook,
  openGoToFolder,
  openSettings = () => {},
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
      // View-local and clipboard handlers run before this window listener. Once
      // one of them consumes a chord, never dispatch a second global action or
      // fall through to type-to-select.
      if (event.defaultPrevented) return;

      const isInputField = isEditableShortcutTarget(event.target);
      if (isInputField) return;

      const matches = (id: ShortcutId) => matchesShortcut(event, shortcuts[id]);
      const dispatch = (id: ShortcutId, action: () => void) => {
        if (!matches(id)) return false;
        event.preventDefault();
        action();
        return true;
      };

      if (dispatch('edit-delete', deleteSelection)) return;
      if (dispatch('nav-up', goUp)) return;
      if (dispatch('view-refresh', refresh)) return;

      if (dispatch('view-list', () => setViewMode('list'))) return;
      if (dispatch('view-grid', () => setViewMode('grid'))) return;
      if (dispatch('view-column', () => setViewMode('column'))) return;
      if (dispatch('view-toggle-hidden', toggleHidden)) return;

      if (dispatch('tab-previous', () => activateTabOffset(-1))) return;
      if (dispatch('tab-next', () => activateTabOffset(1))) return;
      if (dispatch('search-focus', focusSearch)) return;
      if (dispatch('tab-new', addTab)) return;
      if (dispatch('tab-close', () => closeTab(activeTabId))) return;

      if (dispatch('nav-back', goBack)) return;
      if (dispatch('nav-forward', goForward)) return;

      if (
        matches('view-quick-look') &&
        !isInputField &&
        !isQuickLookOpen &&
        selectedFileIsPreviewable
      ) {
        event.preventDefault();
        openQuickLook();
        return;
      }

      if (dispatch('nav-go-to-folder', openGoToFolder)) return;
      if (dispatch('settings-open', openSettings)) return;
      if (dispatch('command-palette', openCommandPalette)) return;

      if (import.meta.env.DEV && dispatch('debug-toggle', toggleDebugPanel)) return;

      if (dispatch('nav-add-favorite', () => currentPath && addFavorite(currentPath))) return;
      if (dispatch('help-keyboard-shortcuts', toggleShortcutsOverlay)) return;

      if (matches('edit-undo')) {
        event.preventDefault();
        if (canUndo) void undo();
        return;
      }

      if (matches('edit-redo') || matches('edit-redo-alternate')) {
        event.preventDefault();
        if (canRedo) void redo();
        return;
      }

      if (matches('view-increase-thumbnail') && viewMode === 'grid') {
        event.preventDefault();
        increaseThumbnailSize();
        return;
      }

      if (matches('view-decrease-thumbnail') && viewMode === 'grid') {
        event.preventDefault();
        decreaseThumbnailSize();
        return;
      }

      if (
        !isInputField &&
        event.key.length === 1 &&
        event.key.trim().length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
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
    decreaseThumbnailSize,
    deleteSelection,
    focusSearch,
    goBack,
    goForward,
    goUp,
    increaseThumbnailSize,
    isQuickLookOpen,
    openCommandPalette,
    openGoToFolder,
    openQuickLook,
    openSettings,
    redo,
    refresh,
    selectedFileIsPreviewable,
    setViewMode,
    shortcuts,
    toggleDebugPanel,
    toggleHidden,
    toggleShortcutsOverlay,
    typeToSelect,
    undo,
    viewMode,
  ]);
}
