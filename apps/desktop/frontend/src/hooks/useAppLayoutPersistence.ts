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
const FILE_SURFACE_MIN = 420;
const SPLITTER_WIDTH = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function calculatePaneLayout(
  containerWidth: number,
  preferredSidebarWidth: number,
  preferredPreviewWidth: number,
  previewRequested: boolean
) {
  const sidebarMax = Math.min(
    SIDEBAR_MAX,
    Math.max(SIDEBAR_MIN, containerWidth - SPLITTER_WIDTH - FILE_SURFACE_MIN)
  );
  const sidebarWidth = clamp(preferredSidebarWidth, SIDEBAR_MIN, sidebarMax);
  const mainWidth = Math.max(0, containerWidth - sidebarWidth - SPLITTER_WIDTH);
  const previewVisible =
    previewRequested && mainWidth >= FILE_SURFACE_MIN + SPLITTER_WIDTH + PREVIEW_MIN;
  const previewMax = Math.min(
    PREVIEW_MAX,
    Math.max(PREVIEW_MIN, mainWidth - SPLITTER_WIDTH - FILE_SURFACE_MIN)
  );

  return {
    sidebarWidth,
    previewWidth: previewVisible
      ? clamp(preferredPreviewWidth, PREVIEW_MIN, previewMax)
      : clamp(preferredPreviewWidth, PREVIEW_MIN, PREVIEW_MAX),
    previewVisible,
  };
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
