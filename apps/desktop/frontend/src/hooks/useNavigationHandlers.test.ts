import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewMode } from '../components/ViewModeToggle';
import { useNavigationHandlers } from './useNavigationHandlers';

function renderNavigation(currentPath = '/a') {
  const setCurrentPath = vi.fn();
  const setPathStack = vi.fn();
  const clearActiveSmartFolder = vi.fn();
  const buildPathStackFromPath = vi.fn((path: string) => [`stack:${path}`]);
  const showToast = vi.fn(() => 'toast-id');
  const viewModeRef = { current: 'column' } as React.MutableRefObject<ViewMode>;

  const hook = renderHook(
    ({ path }) =>
      useNavigationHandlers({
        activeTabId: 'tab-1',
        currentPath: path,
        setCurrentPath,
        setPathStack,
        clearActiveSmartFolder,
        viewModeRef,
        buildPathStackFromPath,
        showToast,
      }),
    {
      initialProps: { path: currentPath },
    }
  );

  return {
    ...hook,
    setCurrentPath,
    setPathStack,
    clearActiveSmartFolder,
    buildPathStackFromPath,
    showToast,
    viewModeRef,
  };
}

describe('useNavigationHandlers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('navigates back and forward while syncing column path stacks', () => {
    const nav = renderNavigation('/a');

    act(() => {
      nav.rerender({ path: '/b' });
    });

    expect(nav.result.current.canGoBack).toBe(true);
    expect(nav.result.current.backHistory).toEqual(['/a']);

    act(() => {
      nav.result.current.handleGoBack();
    });

    expect(nav.clearActiveSmartFolder).toHaveBeenCalledTimes(1);
    expect(nav.setCurrentPath).toHaveBeenCalledWith('/a');
    expect(nav.setPathStack).toHaveBeenCalledWith(['stack:/a']);

    act(() => {
      nav.rerender({ path: '/a' });
    });

    expect(nav.result.current.canGoForward).toBe(true);

    act(() => {
      nav.result.current.handleGoForward();
    });

    expect(nav.setCurrentPath).toHaveBeenCalledWith('/b');
    expect(nav.setPathStack).toHaveBeenCalledWith(['stack:/b']);
  });

  it('jumps to selected history indexes and skips path-stack sync outside column view', () => {
    const nav = renderNavigation('/one');

    act(() => {
      nav.rerender({ path: '/two' });
    });
    act(() => {
      nav.rerender({ path: '/three' });
    });

    act(() => {
      nav.result.current.handleGoToBackIndex(1);
    });

    expect(nav.setCurrentPath).toHaveBeenCalledWith('/one');
    expect(nav.setPathStack).toHaveBeenCalledWith(['stack:/one']);

    act(() => {
      nav.rerender({ path: '/one' });
    });

    nav.viewModeRef.current = 'list' as never;

    act(() => {
      nav.result.current.handleGoToForwardIndex(1);
    });

    expect(nav.setCurrentPath).toHaveBeenCalledWith('/three');
    expect(nav.setPathStack).not.toHaveBeenCalledWith(['stack:/three']);
  });

  it('clears navigation history from the command palette', () => {
    const nav = renderNavigation('/a');

    act(() => {
      nav.rerender({ path: '/b' });
    });
    expect(nav.result.current.backHistory).toEqual(['/a']);

    act(() => {
      nav.result.current.handleClearHistoryFromPalette();
    });

    expect(nav.result.current.backHistory).toEqual([]);
    expect(nav.showToast).toHaveBeenCalledWith('Navigation history cleared', {
      type: 'success',
    });
  });
});
