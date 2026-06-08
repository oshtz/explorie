import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type SystemLocations = {
  desktop?: string;
  documents?: string;
  downloads?: string;
  music?: string;
  pictures?: string;
  videos?: string;
  home?: string;
  drives: string[];
};

const CURRENT_PATH_KEY = 'explorie:currentPath';
const isDevBuild = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

function shouldUseDevBrowserFallback(): boolean {
  try {
    return isDevBuild && !isTauri();
  } catch {
    return false;
  }
}

function readStoredCurrentPath(): string | null {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(CURRENT_PATH_KEY);
      if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw;
      }
    }
  } catch {
    // Ignore storage read errors (private mode, etc.)
  }
  return null;
}

function pickPreferredPath(locations: SystemLocations | null): string | null {
  if (!locations) return null;
  const candidates: Array<string | undefined> = [
    locations.documents,
    locations.desktop,
    locations.downloads,
    locations.home,
    locations.pictures,
    locations.music,
    locations.videos,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate;
  }
  if (Array.isArray(locations.drives)) {
    const firstDrive = locations.drives.find((drive) => drive && drive.trim().length > 0);
    if (firstDrive) return firstDrive;
  }
  return null;
}

export function useInitialPath() {
  const storedPath = useMemo(() => readStoredCurrentPath(), []);
  const devBrowserFallbackPath = useMemo(() => (shouldUseDevBrowserFallback() ? '/' : ''), []);
  const fromStorageRef = useRef<boolean>(!!storedPath);
  const [currentPath, setCurrentPath] = useState<string>(storedPath ?? devBrowserFallbackPath);
  const [initializing, setInitializing] = useState<boolean>(
    () => !storedPath && !devBrowserFallbackPath
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (currentPath) {
        window.localStorage.setItem(CURRENT_PATH_KEY, currentPath);
      }
    } catch {
      // Swallow storage write failures
    }
  }, [currentPath]);

  useEffect(() => {
    if (fromStorageRef.current) {
      setInitializing(false);
      return;
    }
    if (devBrowserFallbackPath) {
      setInitializing(false);
      return;
    }
    let cancelled = false;
    invoke<SystemLocations>('list_system_locations')
      .then((locations) => {
        if (cancelled) return;
        const preferred = pickPreferredPath(locations);
        if (preferred) {
          setCurrentPath((prev) => (prev && prev.trim().length > 0 ? prev : preferred));
        }
      })
      .catch(() => {
        // Non-fatal: fall back to empty path until user picks one manually.
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [devBrowserFallbackPath]);

  const updatePath = useCallback((next: string) => {
    setCurrentPath(next);
    fromStorageRef.current = true;
  }, []);

  return {
    currentPath,
    setCurrentPath: updatePath,
    initializing,
  };
}

export { readStoredCurrentPath, pickPreferredPath };
