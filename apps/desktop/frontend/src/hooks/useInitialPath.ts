import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatErrorMessage } from '../utils/errorMessages';

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
  const [initializing, setInitializing] = useState<boolean>(() => !devBrowserFallbackPath);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);

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
    if (devBrowserFallbackPath) {
      setInitializationError(null);
      setInitializing(false);
      return;
    }
    let cancelled = false;

    const initialize = async () => {
      setInitializationError(null);
      try {
        const launchPath = await invoke<string | null>('get_launch_path');
        if (cancelled) return;
        if (launchPath?.trim()) {
          fromStorageRef.current = true;
          setCurrentPath(launchPath);
          return;
        }
      } catch {
        // Older/dev backends may not expose launch-path activation.
      }

      if (fromStorageRef.current || cancelled) return;
      try {
        const locations = await invoke<SystemLocations>('list_system_locations');
        if (cancelled) return;
        const preferred = pickPreferredPath(locations);
        if (preferred) {
          setCurrentPath(preferred);
        } else {
          setInitializationError('No system locations are available.');
        }
      } catch (error) {
        if (!cancelled) {
          setInitializationError(formatErrorMessage(error));
        }
      }
    };

    void initialize().finally(() => {
      if (!cancelled) setInitializing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [devBrowserFallbackPath, initializationAttempt]);

  const updatePath = useCallback((next: string) => {
    setCurrentPath(next);
    setInitializationError(null);
    fromStorageRef.current = true;
  }, []);

  const retryInitialization = useCallback(() => {
    if (devBrowserFallbackPath) return;
    setInitializing(true);
    setInitializationError(null);
    setInitializationAttempt((attempt) => attempt + 1);
  }, [devBrowserFallbackPath]);

  useEffect(() => {
    if (devBrowserFallbackPath) return;
    let cancelled = false;
    let unlisten = () => {};

    void listen<string>('open-path', ({ payload }) => {
      if (payload?.trim()) updatePath(payload);
    })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Non-fatal outside the Tauri runtime.
      });

    return () => {
      cancelled = true;
      unlisten();
    };
  }, [devBrowserFallbackPath, updatePath]);

  return {
    currentPath,
    setCurrentPath: updatePath,
    initializing,
    initializationError,
    retryInitialization,
  };
}

export { readStoredCurrentPath, pickPreferredPath };
