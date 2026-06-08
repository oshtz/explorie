import type React from 'react';
import { useCallback, useEffect, useState } from 'react';

const SIDEBAR_KEY = 'explorie:sidebarWidth';
const PREVIEW_KEY = 'explorie:previewWidth';
const SIDEBAR_DEFAULT = 220;
const PREVIEW_DEFAULT = 360;
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const PREVIEW_MIN = 280;
const PREVIEW_MAX = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readPersistedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    const parsed = raw ? parseInt(raw, 10) : fallback;
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function persistWidth(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {}
}

export function useAppLayoutPersistence(resizingClassName: string) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readPersistedWidth(SIDEBAR_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)
  );
  const [previewWidth, setPreviewWidth] = useState<number>(() =>
    readPersistedWidth(PREVIEW_KEY, PREVIEW_DEFAULT, PREVIEW_MIN, PREVIEW_MAX)
  );

  useEffect(() => {
    persistWidth(SIDEBAR_KEY, sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    persistWidth(PREVIEW_KEY, previewWidth);
  }, [previewWidth]);

  const handleSidebarResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        setSidebarWidth(clamp(startWidth + dx, SIDEBAR_MIN, SIDEBAR_MAX));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove(resizingClassName);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.classList.add(resizingClassName);
    },
    [resizingClassName, sidebarWidth]
  );

  const handlePreviewResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = previewWidth;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        setPreviewWidth(clamp(startWidth - dx, PREVIEW_MIN, PREVIEW_MAX));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove(resizingClassName);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.classList.add(resizingClassName);
    },
    [previewWidth, resizingClassName]
  );

  return {
    sidebarWidth,
    setSidebarWidth,
    previewWidth,
    setPreviewWidth,
    handleSidebarResizeStart,
    handlePreviewResizeStart,
  };
}
