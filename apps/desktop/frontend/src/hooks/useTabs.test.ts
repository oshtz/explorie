import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabs } from './useTabs';

function renderTabs(overrides: Partial<Parameters<typeof useTabs>[0]> = {}) {
  const setCurrentPath = vi.fn();
  const clearActiveSmartFolder = vi.fn();
  const setSelectedFile = vi.fn();

  const hook = renderHook(
    ({ currentPath }) =>
      useTabs({
        currentPath,
        setCurrentPath,
        clearActiveSmartFolder,
        setSelectedFile,
        ...overrides,
      }),
    {
      initialProps: {
        currentPath: overrides.currentPath ?? '/workspace',
      },
    }
  );

  return {
    ...hook,
    setCurrentPath,
    clearActiveSmartFolder,
    setSelectedFile,
  };
}

describe('useTabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
  });

  it('loads stored tabs, activates tabs, and persists active state', () => {
    localStorage.setItem(
      'explorie:tabs',
      JSON.stringify([
        { id: 'tab-a', path: '/a' },
        { id: 'tab-b', path: '/b' },
      ])
    );
    localStorage.setItem('explorie:activeTabId', 'tab-b');

    const { result, setCurrentPath, setSelectedFile, clearActiveSmartFolder } = renderTabs({
      currentPath: '/b',
    });

    expect(result.current.tabs).toEqual([
      { id: 'tab-a', path: '/a' },
      { id: 'tab-b', path: '/b' },
    ]);
    expect(result.current.activeTabId).toBe('tab-b');

    act(() => {
      result.current.activateTab('tab-a');
    });

    expect(result.current.activeTabId).toBe('tab-a');
    expect(setSelectedFile).toHaveBeenCalledWith(null);
    expect(clearActiveSmartFolder).toHaveBeenCalledTimes(1);
    expect(setCurrentPath).toHaveBeenCalledWith('/a');
    expect(localStorage.getItem('explorie:activeTabId')).toBe('tab-a');
  });

  it('adds tabs from the current path and closes the active tab by selecting a neighbor', () => {
    const { result, setCurrentPath, clearActiveSmartFolder } = renderTabs({
      currentPath: '/workspace',
    });

    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      result.current.addTab();
    });

    expect(result.current.tabs).toEqual([
      { id: 'tab-1700000000000', path: '/workspace' },
      { id: 'tab-1700000000000-420000', path: '/workspace' },
    ]);
    expect(result.current.activeTabId).toBe('tab-1700000000000-420000');

    act(() => {
      result.current.closeTab('tab-1700000000000-420000');
    });

    expect(result.current.tabs).toEqual([{ id: 'tab-1700000000000', path: '/workspace' }]);
    expect(result.current.activeTabId).toBe('tab-1700000000000');
    expect(clearActiveSmartFolder).toHaveBeenCalledTimes(1);
    expect(setCurrentPath).toHaveBeenCalledWith('/workspace');
  });

  it('falls back when stored data is invalid and prevents closing the last tab', () => {
    localStorage.setItem('explorie:tabs', 'not json');
    localStorage.setItem('explorie:currentPath', '/stored');

    const { result } = renderTabs({ currentPath: '' });

    expect(result.current.tabs).toEqual([{ id: 'tab-1700000000000', path: '/stored' }]);

    act(() => {
      result.current.closeTab('tab-1700000000000');
    });

    expect(result.current.tabs).toEqual([{ id: 'tab-1700000000000', path: '/stored' }]);
  });

  it('repairs an active tab id that is missing from the tab list', () => {
    localStorage.setItem(
      'explorie:tabs',
      JSON.stringify([
        { id: 'tab-a', path: '/a' },
        { id: 'tab-b', path: '/b' },
      ])
    );
    localStorage.setItem('explorie:activeTabId', 'missing');

    const { result, setCurrentPath } = renderTabs({ currentPath: '/a' });

    expect(result.current.activeTabId).toBe('tab-a');
    expect(setCurrentPath).toHaveBeenCalledWith('/a');
  });
});
