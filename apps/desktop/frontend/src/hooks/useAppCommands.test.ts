import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppCommands } from './useAppCommands';

function renderCommands(overrides: Partial<Parameters<typeof useAppCommands>[0]> = {}) {
  const handlers = {
    goBack: vi.fn(),
    goForward: vi.fn(),
    goToFolder: vi.fn(),
    goUp: vi.fn(),
    clearHistory: vi.fn(),
    setViewMode: vi.fn(),
    toggleHidden: vi.fn(),
    togglePreview: vi.fn(),
    toggleStatusBar: vi.fn(),
    refresh: vi.fn(),
    addTab: vi.fn(),
    closeActiveTab: vi.fn(),
    newFolder: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    openSettings: vi.fn(),
    setTheme: vi.fn(),
    addFavorite: vi.fn(),
    showKeyboardShortcuts: vi.fn(),
    openWorkspaceManager: vi.fn(),
    saveWorkspace: vi.fn(),
  };
  const hook = renderHook(() =>
    useAppCommands({
      showHidden: false,
      showPreviewPanel: true,
      showStatusBar: true,
      handlers,
      ...overrides,
    })
  );
  return { ...hook, handlers };
}

describe('useAppCommands', () => {
  it('builds stable command ids and dynamic labels', () => {
    const { result } = renderCommands({
      showHidden: true,
      showPreviewPanel: false,
      showStatusBar: false,
    });

    expect(result.current.map((command) => command.id)).toContain('nav-back');
    expect(result.current.find((command) => command.id === 'view-toggle-hidden')?.name).toBe(
      'Hide Hidden Files'
    );
    expect(result.current.find((command) => command.id === 'view-toggle-preview')?.name).toBe(
      'Show Preview Panel'
    );
    expect(result.current.find((command) => command.id === 'view-toggle-status-bar')?.name).toBe(
      'Show Status Bar'
    );
  });

  it('delegates command actions to supplied handlers', () => {
    const { result, handlers } = renderCommands();

    result.current.find((command) => command.id === 'nav-back')?.action();
    result.current.find((command) => command.id === 'settings-theme-light')?.action();
    result.current.find((command) => command.id === 'workspace-save')?.action();

    expect(handlers.goBack).toHaveBeenCalledTimes(1);
    expect(handlers.setTheme).toHaveBeenCalledWith('light');
    expect(handlers.saveWorkspace).toHaveBeenCalledTimes(1);
  });
});
