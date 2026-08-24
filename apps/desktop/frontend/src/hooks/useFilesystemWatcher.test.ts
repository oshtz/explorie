import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILESYSTEM_WATCH_DEBOUNCE_MS,
  FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE,
  isFilesystemAccessEvent,
  isPathCoveredByMount,
  isRemoteDrivePath,
  normalizeWatchPaths,
  useFilesystemWatcher,
} from './useFilesystemWatcher';

const REMOTE_PROFILE = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Cloud',
  remote: 'gdrive',
  remotePath: '',
  mountTarget: 'R:',
};

const fsWatch = vi.hoisted(() => {
  const callbacks: Array<(event: { type: unknown }) => void> = [];
  const unwatch = vi.fn();
  const watch = vi.fn(
    async (_paths: string[], callback: (event: { type: unknown }) => void): Promise<() => void> => {
      callbacks.push(callback);
      return unwatch;
    }
  );
  return { callbacks, unwatch, watch };
});

const remoteEvents = vi.hoisted(() => {
  const callbacks: Array<
    (event: { payload: { state: string; mountPath?: string | null } }) => void
  > = [];
  const unlisten = vi.fn();
  const listen = vi.fn(async (_event: string, callback: (event: { payload: unknown }) => void) => {
    callbacks.push(callback);
    return unlisten;
  });
  return { callbacks, listen, unlisten };
});

vi.mock('@tauri-apps/plugin-fs', () => ({
  watch: fsWatch.watch,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: remoteEvents.listen,
}));

async function flushWatchSetup() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useFilesystemWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    fsWatch.callbacks.length = 0;
    fsWatch.unwatch.mockClear();
    fsWatch.watch.mockReset();
    fsWatch.watch.mockImplementation(
      async (
        _paths: string[],
        callback: (event: { type: unknown }) => void
      ): Promise<() => void> => {
        fsWatch.callbacks.push(callback);
        return fsWatch.unwatch;
      }
    );
    remoteEvents.callbacks.length = 0;
    remoteEvents.unlisten.mockClear();
    remoteEvents.listen.mockClear();
    remoteEvents.listen.mockImplementation(
      async (_event: string, callback: (event: { payload: unknown }) => void) => {
        remoteEvents.callbacks.push(callback);
        return remoteEvents.unlisten;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('normalizes and deduplicates visible paths', () => {
    expect(normalizeWatchPaths(['/root/', '\\root', '/root/child', '/root/child/'])).toEqual([
      '/root',
      '/root/child',
    ]);
  });

  it('treats remote mount roots as covering nested watch paths', () => {
    expect(isPathCoveredByMount('R:\\photos', 'R:\\')).toBe(true);
    expect(isPathCoveredByMount('/Volumes/Drive/docs', '/Volumes/Drive')).toBe(true);
    expect(isPathCoveredByMount('/root', '/other')).toBe(false);
    expect(isPathCoveredByMount('/root', null)).toBe(false);
    expect(isRemoteDrivePath('R:\\photos', [{ mountTarget: 'R:' }])).toBe(true);
    expect(isRemoteDrivePath('/root', [{ mountTarget: 'R:' }])).toBe(false);
  });

  it('ignores access events and coalesces create, rename, move, and delete bursts', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useFilesystemWatcher({
        enabled: true,
        paths: ['/root'],
        scopeKey: 'tab-1:list',
        onChange,
      })
    );
    await flushWatchSetup();

    expect(result.current.status).toBe('watching');
    expect(fsWatch.watch).toHaveBeenCalledTimes(1);
    expect(fsWatch.callbacks).toHaveLength(1);

    act(() => fsWatch.callbacks[0]({ type: { access: { kind: 'open', mode: 'read' } } }));
    act(() => {
      fsWatch.callbacks[0]({ type: { create: { kind: 'file' } } });
      fsWatch.callbacks[0]({ type: { modify: { kind: 'rename', mode: 'both' } } });
      fsWatch.callbacks[0]({ type: { remove: { kind: 'file' } } });
    });

    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(FILESYSTEM_WATCH_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('re-registers on tab/view scope changes and column path changes', async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ paths, scopeKey }: { paths: string[]; scopeKey: string }) =>
        useFilesystemWatcher({ enabled: true, paths, scopeKey, onChange }),
      { initialProps: { paths: ['/root', '/root/child'], scopeKey: 'tab-1:column' } }
    );
    await flushWatchSetup();
    expect(fsWatch.watch).toHaveBeenCalledTimes(1);

    rerender({ paths: ['/root/', '\\root/child/'], scopeKey: 'tab-1:column' });
    await flushWatchSetup();
    expect(fsWatch.watch).toHaveBeenCalledTimes(1);
    expect(fsWatch.unwatch).not.toHaveBeenCalled();

    rerender({ paths: ['/root', '/root/child'], scopeKey: 'tab-2:column' });
    await flushWatchSetup();
    expect(fsWatch.unwatch).toHaveBeenCalledTimes(1);
    expect(fsWatch.watch).toHaveBeenCalledTimes(2);

    rerender({ paths: ['/root', '/root/other'], scopeKey: 'tab-2:column' });
    await flushWatchSetup();
    expect(fsWatch.unwatch).toHaveBeenCalledTimes(2);
    expect(fsWatch.watch).toHaveBeenCalledTimes(3);
  });

  it('cleans up the watcher and pending refresh on unmount', async () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() =>
      useFilesystemWatcher({
        enabled: true,
        paths: ['/root'],
        scopeKey: 'tab-1:grid',
        onChange,
      })
    );
    await flushWatchSetup();

    act(() => fsWatch.callbacks[0]({ type: { create: { kind: 'file' } } }));
    unmount();
    expect(fsWatch.unwatch).toHaveBeenCalledTimes(1);
    expect(remoteEvents.unlisten).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(FILESYSTEM_WATCH_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('surfaces unavailable watchers and can retry them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onChange = vi.fn();
    fsWatch.watch.mockRejectedValueOnce(new Error('mount unavailable'));
    const { result } = renderHook(() =>
      useFilesystemWatcher({
        enabled: true,
        paths: ['/root'],
        scopeKey: 'tab-1:list',
        onChange,
      })
    );
    await flushWatchSetup();

    expect(result.current.status).toBe('unavailable');
    expect(result.current.error).toBe(FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    await act(async () => {
      result.current.retry();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fsWatch.watch).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('watching');
  });

  it('does not native-watch remote-drive paths', async () => {
    window.localStorage.setItem('explorie:remoteDrives', JSON.stringify([REMOTE_PROFILE]));
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useFilesystemWatcher({
        enabled: true,
        paths: ['R:\\photos'],
        scopeKey: 'tab-1:list',
        onChange,
      })
    );
    await flushWatchSetup();

    expect(fsWatch.watch).not.toHaveBeenCalled();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.error).toBe(FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE);

    await act(async () => {
      result.current.retry();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fsWatch.watch).not.toHaveBeenCalled();
    expect(result.current.status).toBe('unavailable');
  });

  it('degrades to unavailable when a covering remote mount disconnects', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useFilesystemWatcher({
        enabled: true,
        paths: ['R:\\photos'],
        scopeKey: 'tab-1:list',
        onChange,
      })
    );
    await flushWatchSetup();
    expect(result.current.status).toBe('watching');

    act(() =>
      remoteEvents.callbacks[0]({
        payload: { state: 'disconnected', mountPath: 'R:\\' },
      })
    );

    expect(result.current.status).toBe('unavailable');
    expect(result.current.error).toBe(FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE);
    expect(fsWatch.unwatch).toHaveBeenCalledTimes(1);
  });

  it('recognizes only native access events as non-refreshing reads', () => {
    expect(isFilesystemAccessEvent({ type: { access: { kind: 'open', mode: 'read' } } })).toBe(
      true
    );
    expect(isFilesystemAccessEvent({ type: { modify: { kind: 'rename', mode: 'both' } } })).toBe(
      false
    );
    expect(isFilesystemAccessEvent({ type: 'other' })).toBe(false);
  });
});
