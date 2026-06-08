import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../store';
import { useWorkspaceManager } from './useWorkspaceManager';

const mocks = vi.hoisted(() => ({
  setSize: vi.fn(),
  setPosition: vi.fn(),
  outerSize: vi.fn(),
  outerPosition: vi.fn(),
  getCurrentWindow: vi.fn(),
  logicalSizeConstructs: [] as Array<{ width: number; height: number }>,
  logicalPositionConstructs: [] as Array<{ x: number; y: number }>,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      mocks.logicalSizeConstructs.push({ width, height });
    }
  },
  LogicalPosition: class LogicalPosition {
    x: number;
    y: number;

    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
      mocks.logicalPositionConstructs.push({ x, y });
    }
  },
}));

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    name: 'Design',
    tabs: [
      { id: 'tab-a', path: '/a' },
      { id: 'tab-b', path: '/b' },
    ],
    activeTabId: 'tab-b',
    viewMode: 'list',
    sortKey: 'name',
    sortDir: 'asc',
    showHidden: false,
    filterMode: 'all',
    showPreviewPanel: false,
    gridMinWidth: 160,
    createdAt: 1_767_225_600_000,
    updatedAt: 1_767_312_000_000,
    sidebarWidth: 280,
    windowWidth: 1200,
    windowHeight: 800,
    windowX: 20,
    windowY: 30,
    ...overrides,
  };
}

function renderManager(overrides: Partial<Parameters<typeof useWorkspaceManager>[0]> = {}) {
  const props = {
    currentPath: '/current',
    setTabs: vi.fn(),
    setActiveTabId: vi.fn(),
    setCurrentPath: vi.fn(),
    setSelectedFile: vi.fn(),
    setSidebarWidth: vi.fn(),
    sidebarWidth: 240,
    clearActiveSmartFolder: vi.fn(),
    ...overrides,
  };

  return {
    props,
    ...renderHook(() => useWorkspaceManager(props)),
  };
}

describe('useWorkspaceManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.setSize.mockReset();
    mocks.setPosition.mockReset();
    mocks.outerSize.mockReset();
    mocks.outerPosition.mockReset();
    mocks.getCurrentWindow.mockReset();
    mocks.logicalSizeConstructs = [];
    mocks.logicalPositionConstructs = [];
    mocks.getCurrentWindow.mockReturnValue({
      setSize: mocks.setSize,
      setPosition: mocks.setPosition,
      outerSize: mocks.outerSize,
      outerPosition: mocks.outerPosition,
    });
    mocks.outerSize.mockResolvedValue({ width: 1024, height: 768 });
    mocks.outerPosition.mockResolvedValue({ x: 12, y: 34 });
  });

  it('loads workspace tabs, active path, sidebar width, and window bounds', async () => {
    const { result, props } = renderManager();

    await act(async () => {
      await result.current.handleLoadWorkspace(workspace());
    });

    expect(props.setTabs).toHaveBeenCalledWith([
      { id: 'tab-a', path: '/a' },
      { id: 'tab-b', path: '/b' },
    ]);
    expect(props.setActiveTabId).toHaveBeenCalledWith('tab-b');
    expect(props.clearActiveSmartFolder).toHaveBeenCalledTimes(1);
    expect(props.setCurrentPath).toHaveBeenCalledWith('/b');
    expect(props.setSelectedFile).toHaveBeenCalledWith(null);
    expect(props.setSidebarWidth).toHaveBeenCalledWith(280);
    expect(mocks.logicalSizeConstructs).toEqual([{ width: 1200, height: 800 }]);
    expect(mocks.logicalPositionConstructs).toEqual([{ x: 20, y: 30 }]);
    expect(mocks.setSize).toHaveBeenCalledTimes(1);
    expect(mocks.setPosition).toHaveBeenCalledTimes(1);
  });

  it('falls back when workspace has no tabs or stale active tab id', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const { result, props } = renderManager({ currentPath: '/fallback' });

    await act(async () => {
      await result.current.handleLoadWorkspace(
        workspace({
          tabs: [],
          activeTabId: 'missing',
          sidebarWidth: undefined,
          windowWidth: undefined,
          windowHeight: undefined,
          windowX: undefined,
          windowY: undefined,
        })
      );
    });

    expect(props.setTabs).toHaveBeenCalledWith([{ id: 'tab-1700000000000', path: '/fallback' }]);
    expect(props.setActiveTabId).toHaveBeenCalledWith('tab-1700000000000');
    expect(props.setCurrentPath).toHaveBeenCalledWith('/fallback');
    expect(props.setSidebarWidth).not.toHaveBeenCalled();
    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.setPosition).not.toHaveBeenCalled();
  });

  it('returns window and sidebar state, with safe window fallback', async () => {
    const { result } = renderManager({ sidebarWidth: 320 });

    await expect(result.current.getWindowState()).resolves.toEqual({
      width: 1024,
      height: 768,
      x: 12,
      y: 34,
    });
    expect(result.current.getSidebarState()).toEqual({ width: 320, collapsed: false });

    mocks.outerSize.mockRejectedValue(new Error('window unavailable'));
    await expect(result.current.getWindowState()).resolves.toEqual({});
  });
});
