import { useMemo } from 'react';
import type { Command } from '../components/CommandPalette';
import type { ViewMode } from '../components/ViewModeToggle';
import { useFileStore } from '../store';
import type { ThemeMode } from '../store/types';
import { COMMAND_SHORTCUT_IDS, formatChordDisplay, type ShortcutMap } from '../utils/shortcuts';

interface AppCommandHandlers {
  goBack: () => void;
  goForward: () => void;
  goToFolder: () => void;
  goUp: () => void;
  clearHistory: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleHidden: () => void;
  togglePreview: () => void;
  toggleStatusBar: () => void;
  refresh: () => void;
  addTab: () => void;
  closeActiveTab: () => void;
  newFolder: () => void;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
  openSettings: () => void;
  setTheme: (theme: ThemeMode) => void;
  addFavorite: () => void;
  showKeyboardShortcuts: () => void;
  openWorkspaceManager: () => void;
  saveWorkspace: () => void;
}

interface UseAppCommandsInput {
  showHidden: boolean;
  showPreviewPanel: boolean;
  showStatusBar: boolean;
  handlers: AppCommandHandlers;
}

function shortcutFor(commandId: string, shortcuts: ShortcutMap) {
  const id = COMMAND_SHORTCUT_IDS[commandId];
  return id ? formatChordDisplay(shortcuts[id]) : undefined;
}

export function useAppCommands({
  showHidden,
  showPreviewPanel,
  showStatusBar,
  handlers,
}: UseAppCommandsInput): Command[] {
  const shortcuts = useFileStore((state) => state.shortcuts);

  return useMemo<Command[]>(
    () => [
      {
        id: 'nav-back',
        name: 'Go Back',
        shortcut: shortcutFor('nav-back', shortcuts),
        category: 'navigation',
        action: handlers.goBack,
      },
      {
        id: 'nav-forward',
        name: 'Go Forward',
        shortcut: shortcutFor('nav-forward', shortcuts),
        category: 'navigation',
        action: handlers.goForward,
      },
      {
        id: 'nav-go-to-folder',
        name: 'Go to Folder...',
        shortcut: shortcutFor('nav-go-to-folder', shortcuts),
        category: 'navigation',
        action: handlers.goToFolder,
      },
      {
        id: 'nav-up',
        name: 'Go Up One Directory',
        category: 'navigation',
        action: handlers.goUp,
      },
      {
        id: 'nav-clear-history',
        name: 'Clear Navigation History',
        category: 'navigation',
        action: handlers.clearHistory,
      },
      {
        id: 'view-list',
        name: 'Switch to List View',
        shortcut: shortcutFor('view-list', shortcuts),
        category: 'view',
        action: () => handlers.setViewMode('list'),
      },
      {
        id: 'view-grid',
        name: 'Switch to Grid View',
        shortcut: shortcutFor('view-grid', shortcuts),
        category: 'view',
        action: () => handlers.setViewMode('grid'),
      },
      {
        id: 'view-column',
        name: 'Switch to Column View',
        shortcut: shortcutFor('view-column', shortcuts),
        category: 'view',
        action: () => handlers.setViewMode('column'),
      },
      {
        id: 'view-toggle-hidden',
        name: showHidden ? 'Hide Hidden Files' : 'Show Hidden Files',
        shortcut: shortcutFor('view-toggle-hidden', shortcuts),
        category: 'view',
        action: handlers.toggleHidden,
      },
      {
        id: 'view-toggle-preview',
        name: showPreviewPanel ? 'Hide Preview Panel' : 'Show Preview Panel',
        category: 'view',
        action: handlers.togglePreview,
      },
      {
        id: 'view-toggle-status-bar',
        name: showStatusBar ? 'Hide Status Bar' : 'Show Status Bar',
        category: 'view',
        action: handlers.toggleStatusBar,
      },
      {
        id: 'view-refresh',
        name: 'Refresh',
        shortcut: shortcutFor('view-refresh', shortcuts),
        category: 'view',
        action: handlers.refresh,
      },
      {
        id: 'tab-new',
        name: 'New Tab',
        shortcut: shortcutFor('tab-new', shortcuts),
        category: 'tab',
        action: handlers.addTab,
      },
      {
        id: 'tab-close',
        name: 'Close Tab',
        shortcut: shortcutFor('tab-close', shortcuts),
        category: 'tab',
        action: handlers.closeActiveTab,
      },
      {
        id: 'file-new-folder',
        name: 'New Folder',
        category: 'file',
        action: handlers.newFolder,
      },
      {
        id: 'edit-undo',
        name: 'Undo',
        shortcut: shortcutFor('edit-undo', shortcuts),
        category: 'file',
        action: handlers.undo,
      },
      {
        id: 'edit-redo',
        name: 'Redo',
        shortcut: shortcutFor('edit-redo', shortcuts),
        category: 'file',
        action: handlers.redo,
      },
      {
        id: 'settings-open',
        name: 'Open Settings',
        category: 'settings',
        action: handlers.openSettings,
      },
      {
        id: 'settings-theme-dark',
        name: 'Switch to Dark Theme',
        category: 'settings',
        action: () => handlers.setTheme('dark'),
      },
      {
        id: 'settings-theme-light',
        name: 'Switch to Light Theme',
        category: 'settings',
        action: () => handlers.setTheme('light'),
      },
      {
        id: 'settings-theme-system',
        name: 'Use System Theme',
        category: 'settings',
        action: () => handlers.setTheme('system'),
      },
      {
        id: 'nav-add-favorite',
        name: 'Add Current Folder to Favorites',
        shortcut: shortcutFor('nav-add-favorite', shortcuts),
        category: 'navigation',
        action: handlers.addFavorite,
      },
      {
        id: 'help-keyboard-shortcuts',
        name: 'Show Keyboard Shortcuts',
        shortcut: shortcutFor('help-keyboard-shortcuts', shortcuts),
        category: 'settings',
        action: handlers.showKeyboardShortcuts,
      },
      {
        id: 'workspace-manager',
        name: 'Manage Workspaces',
        category: 'settings',
        action: handlers.openWorkspaceManager,
      },
      {
        id: 'workspace-save',
        name: 'Save Current Workspace',
        category: 'settings',
        action: handlers.saveWorkspace,
      },
    ],
    [handlers, shortcuts, showHidden, showPreviewPanel, showStatusBar]
  );
}
