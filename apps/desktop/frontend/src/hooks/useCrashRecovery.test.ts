import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrashRecovery } from './useCrashRecovery';

type MockRecoveryInfo = {
  available: boolean;
  lastSaveAt: Date | null;
  tabCount: number;
  pendingOpCount: number;
  currentPath: string | null;
};

const mocks = vi.hoisted(() => ({
  recoveryInfo: {
    available: false,
    lastSaveAt: null,
    tabCount: 0,
    pendingOpCount: 0,
    currentPath: null,
  } as MockRecoveryInfo,
  sessionState: null as null | {
    tabs: Array<{ id: string; path: string }>;
    activeTabId: string;
    currentPath: string;
  },
  sessionManager: {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    saveNow: vi.fn(),
    dismissRecovery: vi.fn(),
  },
  getRecoveryInfo: vi.fn(),
  getSessionState: vi.fn(),
  storeState: {
    viewMode: 'list',
    sortKey: 'name',
    sortDir: 'asc',
    showHidden: false,
  },
}));

vi.mock('../utils/crashRecovery', () => ({
  sessionManager: mocks.sessionManager,
  getRecoveryInfo: mocks.getRecoveryInfo,
  getSessionState: mocks.getSessionState,
}));

vi.mock('../store', () => ({
  useFileStore: (selector: (state: typeof mocks.storeState) => unknown) =>
    selector(mocks.storeState),
}));

vi.mock('zustand/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

function renderRecoveryHook(overrides: Partial<Parameters<typeof useCrashRecovery>[0]> = {}) {
  const options = {
    getTabs: vi.fn(() => [{ id: 'tab-1', path: '/work' }]),
    getActiveTabId: vi.fn(() => 'tab-1'),
    getCurrentPath: vi.fn(() => '/work'),
    onRestoreTabs: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };

  return {
    options,
    ...renderHook(() => useCrashRecovery(options)),
  };
}

describe('useCrashRecovery', () => {
  beforeEach(() => {
    mocks.recoveryInfo = {
      available: false,
      lastSaveAt: null,
      tabCount: 0,
      pendingOpCount: 0,
      currentPath: null,
    };
    mocks.sessionState = null;
    mocks.storeState = {
      viewMode: 'list',
      sortKey: 'name',
      sortDir: 'asc',
      showHidden: false,
    };
    mocks.getRecoveryInfo.mockImplementation(() => mocks.recoveryInfo);
    mocks.getSessionState.mockImplementation(() => mocks.sessionState);
    Object.values(mocks.sessionManager).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('initializes the session manager with current tab and view state', async () => {
    mocks.recoveryInfo = {
      available: true,
      lastSaveAt: new Date('2026-06-03T10:00:00Z'),
      tabCount: 1,
      pendingOpCount: 0,
      currentPath: '/work',
    };
    const { result, options, unmount } = renderRecoveryHook();

    await waitFor(() => expect(mocks.sessionManager.initialize).toHaveBeenCalledTimes(1));
    expect(result.current.recoveryAvailable).toBe(true);
    expect(result.current.recoveryInfo).toMatchObject({
      available: true,
      tabCount: 1,
      currentPath: '/work',
    });

    const getState = mocks.sessionManager.initialize.mock.calls[0][0] as () => unknown;
    expect(getState()).toEqual({
      tabs: [{ id: 'tab-1', path: '/work' }],
      activeTabId: 'tab-1',
      currentPath: '/work',
      viewSettings: {
        viewMode: 'list',
        sortKey: 'name',
        sortDir: 'asc',
        showHidden: false,
      },
      sidebarState: {
        favoritesExpanded: true,
        recentsExpanded: true,
        smartFoldersExpanded: true,
      },
    });
    expect(options.getTabs).toHaveBeenCalled();

    unmount();
    expect(mocks.sessionManager.shutdown).toHaveBeenCalledTimes(1);
  });

  it('debounces session saves when view settings change', async () => {
    vi.useFakeTimers();
    const { rerender } = renderRecoveryHook();
    expect(mocks.sessionManager.initialize).toHaveBeenCalledTimes(1);
    mocks.sessionManager.saveNow.mockClear();

    mocks.storeState = {
      viewMode: 'grid',
      sortKey: 'modified',
      sortDir: 'desc',
      showHidden: true,
    };
    rerender();

    expect(mocks.sessionManager.saveNow).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.sessionManager.saveNow).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.sessionManager.saveNow).toHaveBeenCalledTimes(1);
  });

  it('accepts recovery by restoring tabs, navigating, dismissing, and hiding the prompt', async () => {
    mocks.recoveryInfo = {
      available: true,
      lastSaveAt: new Date('2026-06-03T10:00:00Z'),
      tabCount: 2,
      pendingOpCount: 0,
      currentPath: '/recovered',
    };
    mocks.sessionState = {
      tabs: [
        { id: 'tab-1', path: '/work' },
        { id: 'tab-2', path: '/recovered' },
      ],
      activeTabId: 'tab-2',
      currentPath: '/recovered',
    };
    const { result, options } = renderRecoveryHook();

    await waitFor(() => expect(result.current.recoveryAvailable).toBe(true));

    act(() => {
      result.current.acceptRecovery();
    });

    expect(options.onRestoreTabs).toHaveBeenCalledWith(mocks.sessionState.tabs, 'tab-2');
    expect(options.onNavigate).toHaveBeenCalledWith('/recovered');
    expect(mocks.sessionManager.dismissRecovery).toHaveBeenCalledTimes(1);
    expect(result.current.recoveryHandled).toBe(true);
    expect(result.current.recoveryAvailable).toBe(false);
  });

  it('handles missing recovery state and explicit dismissal', async () => {
    mocks.recoveryInfo = {
      available: true,
      lastSaveAt: null,
      tabCount: 0,
      pendingOpCount: 1,
      currentPath: null,
    };
    const { result } = renderRecoveryHook({
      onRestoreTabs: undefined,
      onNavigate: undefined,
    });

    await waitFor(() => expect(result.current.recoveryAvailable).toBe(true));

    act(() => {
      result.current.acceptRecovery();
    });

    expect(mocks.sessionManager.dismissRecovery).not.toHaveBeenCalled();
    expect(result.current.recoveryHandled).toBe(true);

    const second = renderRecoveryHook();
    await waitFor(() => expect(second.result.current.recoveryAvailable).toBe(true));

    act(() => {
      second.result.current.dismissRecovery();
    });

    expect(mocks.sessionManager.dismissRecovery).toHaveBeenCalledTimes(1);
    expect(second.result.current.recoveryHandled).toBe(true);
    expect(second.result.current.recoveryAvailable).toBe(false);
  });
});
