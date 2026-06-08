import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CoreMock = {
  invoke: ReturnType<typeof vi.fn>;
  isTauri: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted((): CoreMock => {
  return {
    invoke: vi.fn(),
    isTauri: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

async function loadHook() {
  vi.resetModules();
  return import('./useInitialPath');
}

describe('useInitialPath', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset();
    mocks.isTauri.mockReturnValue(true);
  });

  it('exports storage and preferred-path helpers', async () => {
    const { readStoredCurrentPath, pickPreferredPath } = await loadHook();

    expect(readStoredCurrentPath()).toBeNull();

    localStorage.setItem('explorie:currentPath', '   ');
    expect(readStoredCurrentPath()).toBeNull();

    localStorage.setItem('explorie:currentPath', '/stored');
    expect(readStoredCurrentPath()).toBe('/stored');

    expect(
      pickPreferredPath({
        desktop: '/desktop',
        documents: '/documents',
        downloads: '/downloads',
        home: '/home',
        drives: ['C:/'],
      })
    ).toBe('/documents');
    expect(pickPreferredPath({ drives: ['', 'D:/'] })).toBe('D:/');
    expect(pickPreferredPath(null)).toBeNull();
  });

  it('uses a stored current path without invoking system locations', async () => {
    localStorage.setItem('explorie:currentPath', '/stored');
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    expect(result.current.currentPath).toBe('/stored');
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('loads a preferred system location and persists manual path updates', async () => {
    mocks.invoke.mockResolvedValue({
      documents: '/documents',
      desktop: '/desktop',
      drives: ['C:/'],
    });
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    expect(result.current.initializing).toBe(true);
    await waitFor(() => expect(result.current.currentPath).toBe('/documents'));
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(localStorage.getItem('explorie:currentPath')).toBe('/documents');

    act(() => {
      result.current.setCurrentPath('/manual');
    });

    expect(result.current.currentPath).toBe('/manual');
    expect(localStorage.getItem('explorie:currentPath')).toBe('/manual');
  });

  it('falls back cleanly when system locations fail', async () => {
    mocks.invoke.mockRejectedValue(new Error('unavailable'));
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.currentPath).toBe('');
  });
});
