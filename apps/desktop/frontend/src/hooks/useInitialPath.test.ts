import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CoreMock = {
  invoke: ReturnType<typeof vi.fn>;
  isTauri: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted((): CoreMock => {
  return {
    invoke: vi.fn(),
    isTauri: vi.fn(),
    listen: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
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
    mocks.listen.mockReset();
    mocks.listen.mockResolvedValue(vi.fn());
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

  it('uses a stored current path when no launch path is supplied', async () => {
    localStorage.setItem('explorie:currentPath', '/stored');
    mocks.invoke.mockResolvedValue(null);
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    expect(result.current.currentPath).toBe('/stored');
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(mocks.invoke).toHaveBeenCalledWith('get_launch_path');
    expect(mocks.invoke).not.toHaveBeenCalledWith('list_system_locations');
  });

  it('prefers a folder supplied by Windows over the stored path', async () => {
    localStorage.setItem('explorie:currentPath', '/stored');
    mocks.invoke.mockResolvedValueOnce('C:\\opened-folder');
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    await waitFor(() => expect(result.current.currentPath).toBe('C:\\opened-folder'));
    expect(localStorage.getItem('explorie:currentPath')).toBe('C:\\opened-folder');
  });

  it('routes later folder opens into the running app', async () => {
    let onOpen: ((event: { payload: string }) => void) | undefined;
    mocks.listen.mockImplementation(async (_event, handler) => {
      onOpen = handler;
      return vi.fn();
    });
    mocks.invoke.mockResolvedValue(null);
    localStorage.setItem('explorie:currentPath', '/stored');
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());
    await waitFor(() => expect(onOpen).toBeDefined());
    act(() => onOpen?.({ payload: 'D:\\second-folder' }));

    expect(result.current.currentPath).toBe('D:\\second-folder');
  });

  it('loads a preferred system location and persists manual path updates', async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === 'get_launch_path'
        ? Promise.resolve(null)
        : Promise.resolve({
            documents: '/documents',
            desktop: '/desktop',
            drives: ['C:/'],
          })
    );
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
    expect(result.current.initializationError).toBe('Unavailable');
  });

  it('reports an empty system-location result as a blocked startup', async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === 'get_launch_path' ? Promise.resolve(null) : Promise.resolve({ drives: [] })
    );
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());

    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.currentPath).toBe('');
    expect(result.current.initializationError).toBe('No system locations are available.');
  });

  it('retries location discovery after a startup failure', async () => {
    let locationAttempts = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_launch_path') return Promise.resolve(null);
      locationAttempts += 1;
      if (locationAttempts === 1) return Promise.reject(new Error('temporarily unavailable'));
      return Promise.resolve({ documents: '/documents', drives: [] });
    });
    const { useInitialPath } = await loadHook();

    const { result } = renderHook(() => useInitialPath());
    await waitFor(() => expect(result.current.initializationError).toBe('Temporarily unavailable'));

    act(() => result.current.retryInitialization());

    await waitFor(() => expect(result.current.currentPath).toBe('/documents'));
    expect(result.current.initializationError).toBeNull();
    expect(result.current.initializing).toBe(false);
  });
});
