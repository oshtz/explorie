import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { watch } from '@tauri-apps/plugin-fs';
import { normalizePath } from '../utils/path';
import type { RemoteDriveStatus } from '../utils/remoteDrives';

export const FILESYSTEM_WATCH_DEBOUNCE_MS = 200;
export const FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE =
  'Live updates are unavailable for this location. Refresh manually or retry live updates.';

export type FilesystemWatcherStatus = 'idle' | 'watching' | 'unavailable';

export type FilesystemWatchEvent = {
  type: unknown;
  paths?: readonly string[];
  attrs?: unknown;
};

export type FilesystemWatcherState = {
  status: FilesystemWatcherStatus;
  error: string | null;
};

type UseFilesystemWatcherOptions = {
  enabled: boolean;
  paths: readonly string[];
  scopeKey: string;
  onChange: () => void | Promise<void>;
  onStatusChange?: (state: FilesystemWatcherState) => void;
};

type StopWatching = () => void | Promise<void>;

/**
 * Normalize and deduplicate the paths sent to the native watcher.
 *
 * The column stack can contain the same directory with different separators
 * after navigation. Keeping one canonical path per directory prevents native
 * backends from registering duplicate watchers for the same location.
 */
export function normalizeWatchPaths(paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    unique.add(normalizePath(path));
  }
  return [...unique].sort();
}

export function isFilesystemAccessEvent(event: FilesystemWatchEvent): boolean {
  return (
    typeof event.type === 'object' &&
    event.type !== null &&
    'access' in (event.type as Record<string, unknown>)
  );
}

export function isPathCoveredByMount(path: string, mountPath: string | null | undefined): boolean {
  if (!mountPath) return false;
  const normalizedPath = normalizePath(path).toLowerCase();
  const normalizedMount = normalizePath(mountPath).toLowerCase();
  if (normalizedPath === normalizedMount) return true;
  const mountPrefix = normalizedMount.endsWith('/') ? normalizedMount : `${normalizedMount}/`;
  return normalizedPath.startsWith(mountPrefix);
}

function isRemoteMountUnavailable(state: RemoteDriveStatus['state']): boolean {
  return state !== 'connected' && state !== 'connecting';
}

function reportStatus(
  onStatusChange: ((state: FilesystemWatcherState) => void) | undefined,
  state: FilesystemWatcherState
) {
  onStatusChange?.(state);
}

/**
 * Keep one native watcher for the current tab/view scope and coalesce native
 * event bursts into one refresh. The watcher is deliberately scoped to the
 * visible directories, not recursive, so unrelated changes do not disturb a
 * user's current place.
 */
export function useFilesystemWatcher({
  enabled,
  paths,
  scopeKey,
  onChange,
  onStatusChange,
}: UseFilesystemWatcherOptions) {
  const [state, setState] = useState<FilesystemWatcherState>({
    status: 'idle',
    error: null,
  });
  const [retryToken, setRetryToken] = useState(0);
  const onChangeRef = useRef(onChange);
  const onStatusChangeRef = useRef(onStatusChange);
  onChangeRef.current = onChange;
  onStatusChangeRef.current = onStatusChange;

  const normalizedPaths = useMemo(() => normalizeWatchPaths(paths), [paths]);
  const pathsKey = normalizedPaths.join('\0');
  const normalizedPathsRef = useRef(normalizedPaths);
  normalizedPathsRef.current = normalizedPaths;
  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let unavailable = false;
    let stopWatching: StopWatching | undefined;
    let unlistenRemote: (() => void) | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;

    const updateState = (next: FilesystemWatcherState) => {
      if (disposed) return;
      setState(next);
      reportStatus(onStatusChangeRef.current, next);
    };

    const stopNativeWatcher = () => {
      const stop = stopWatching;
      stopWatching = undefined;
      if (stop) void Promise.resolve(stop()).catch(() => undefined);
    };

    const markUnavailable = () => {
      unavailable = true;
      stopNativeWatcher();
      updateState({
        status: 'unavailable',
        error: FILESYSTEM_WATCH_UNAVAILABLE_MESSAGE,
      });
    };

    const runRefresh = () => {
      if (disposed) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }

      let refreshResult: void | Promise<void>;
      try {
        refreshResult = onChangeRef.current();
      } catch {
        refreshResult = undefined;
      }

      refreshInFlight = Promise.resolve(refreshResult)
        .catch(() => undefined)
        .then(() => {
          refreshInFlight = null;
          if (disposed || !refreshQueued) return;
          refreshQueued = false;
          scheduleRefresh();
        });
    };

    const scheduleRefresh = () => {
      if (disposed) return;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        runRefresh();
      }, FILESYSTEM_WATCH_DEBOUNCE_MS);
    };

    const handleRemoteStatus = (status: RemoteDriveStatus) => {
      if (disposed || !isRemoteMountUnavailable(status.state)) return;
      if (
        !normalizedPathsRef.current.some((path) => isPathCoveredByMount(path, status.mountPath))
      ) {
        return;
      }
      markUnavailable();
    };

    const startWatching = async () => {
      const watchPaths = normalizedPathsRef.current;
      if (!enabled || watchPaths.length === 0) {
        updateState({ status: 'idle', error: null });
        return;
      }

      updateState({ status: 'idle', error: null });

      void listen<RemoteDriveStatus>('remote-drive-status', (event) => {
        handleRemoteStatus(event.payload);
      })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenRemote = unlisten;
        })
        .catch(() => undefined);

      try {
        const unwatch = await watch(
          watchPaths,
          (event: FilesystemWatchEvent) => {
            if (!isFilesystemAccessEvent(event)) scheduleRefresh();
          },
          { recursive: false, delayMs: 0 }
        );

        if (disposed || unavailable) {
          void Promise.resolve(unwatch()).catch(() => undefined);
          return;
        }

        stopWatching = unwatch;
        updateState({ status: 'watching', error: null });
      } catch (error) {
        if (disposed) return;
        console.warn('Directory watching unavailable:', error);
        markUnavailable();
      }
    };

    void startWatching();

    return () => {
      disposed = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshQueued = false;
      stopNativeWatcher();
      const unlisten = unlistenRemote;
      unlistenRemote = undefined;
      if (unlisten) unlisten();
    };
  }, [enabled, pathsKey, retryToken, scopeKey]);

  return { ...state, retry };
}
