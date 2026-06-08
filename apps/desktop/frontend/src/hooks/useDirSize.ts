import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCachedDirSize, setCachedDirSize } from '../dirSizeCache';

declare global {
  interface Window {
    __explorieInflightSizes?: Map<string, Promise<number>>;
  }
}

/**
 * useDirSize: Returns [size, loading] for a directory path.
 * - Reads from the shared dirSizeCache first.
 * - De-duplicates concurrent requests via a global inflight map.
 */
export function useDirSize(
  path: string | undefined,
  enabled: boolean
): [number | undefined, boolean] {
  const [size, setSize] = React.useState<number | undefined>(() =>
    path ? getCachedDirSize(path) : undefined
  );
  const [loading, setLoading] = React.useState<boolean>(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!enabled || !path)
      return () => {
        cancelled = true;
      };

    // If cached, use it
    const cached = getCachedDirSize(path);
    if (cached !== undefined) {
      setSize(cached);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    // Start fetch (with de-dup)
    setLoading(true);
    window.__explorieInflightSizes ??= new Map<string, Promise<number>>();
    let p = window.__explorieInflightSizes.get(path);
    if (!p) {
      p = invoke<number>('get_dir_size', { path });
      window.__explorieInflightSizes.set(path, p);
    }
    p.then((value) => {
      window.__explorieInflightSizes?.delete(path);
      if (cancelled) return;
      setCachedDirSize(path, value);
      setSize(value);
      setLoading(false);
    }).catch(() => {
      window.__explorieInflightSizes?.delete(path);
      if (cancelled) return;
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return [size, loading];
}
