import { useCallback, useEffect, useState } from 'react';
import type { FileEntry } from '../store';
import type { ViewMode } from '../components/ViewModeToggle';
import { basename, normalizePath } from '../utils/path';
import { moveToFolder } from '../utils/fs';

type DragOverlayState = { label: string; icon: string } | null;

type UseFileDragAndDropOptions = {
  files: FileEntry[];
  columnFiles: { [path: string]: FileEntry[] };
  viewMode: ViewMode;
  refreshVisibleViews: () => Promise<void>;
  getParentPath: (path: string) => string;
};

export function useFileDragAndDrop({
  files,
  columnFiles,
  viewMode,
  refreshVisibleViews,
  getParentPath,
}: UseFileDragAndDropOptions) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [combineTargetId, setCombineTargetId] = useState<string | null>(null);
  const [dragOverlay, setDragOverlay] = useState<DragOverlayState>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dndEpoch, setDndEpoch] = useState(0);
  const [dropPath, setDropPath] = useState<string | null>(null);

  const isDirectory = (file: FileEntry): boolean => {
    return !!file.is_dir;
  };

  const beginDrag = useCallback((entry: FileEntry) => {
    setDraggingId(`file:${entry.id}`);
    const base = entry.name ?? basename(entry.path);
    const icon = (() => {
      if (entry.is_dir) return 'folder';
      const ext = base.split('.').pop()?.toLowerCase();
      switch (ext) {
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'bmp':
        case 'webp':
          return 'image';
        case 'mp4':
        case 'avi':
        case 'mov':
        case 'mkv':
          return 'video';
        case 'mp3':
        case 'wav':
        case 'ogg':
          return 'music';
        case 'zip':
        case 'rar':
        case '7z':
          return 'archive';
        case 'js':
        case 'ts':
        case 'tsx':
        case 'jsx':
        case 'html':
        case 'css':
          return 'code';
        default:
          return 'file';
      }
    })();
    setDragOverlay({ label: base, icon });
    setCombineTargetId(null);
    setDropPath(null);
  }, []);

  const handleHoverFolder = useCallback((file: FileEntry | null) => {
    setCombineTargetId(file ? file.id : null);
  }, []);

  const handleHoverContainerPath = useCallback(
    (path: string) => {
      if (draggingId) setDropPath(path);
    },
    [draggingId]
  );

  const finalizeDrag = useCallback(async () => {
    if (!draggingId) return;
    try {
      const srcId = draggingId.replace(/^file:/, '');
      const findById = (id: string): FileEntry | undefined => {
        if (viewMode === 'list' || viewMode === 'grid') return files.find((f) => f.id === id);
        for (const p of Object.keys(columnFiles)) {
          const hit = (columnFiles[p] || []).find((f) => f.id === id);
          if (hit) return hit;
        }
        return undefined;
      };
      const src = findById(srcId);
      if (!src) return;
      if (combineTargetId) {
        const dst = findById(combineTargetId);
        if (dst && isDirectory(dst)) {
          const srcParent = normalizePath(getParentPath(src.path));
          const targetDir = normalizePath(dst.path);
          if (srcParent !== targetDir) {
            await moveToFolder(src.path, dst.path);
          }
        }
      } else if (dropPath) {
        const srcParent = normalizePath(getParentPath(src.path));
        const targetPath = normalizePath(dropPath);
        if (targetPath !== srcParent) {
          await moveToFolder(src.path, targetPath);
        }
      }
      await refreshVisibleViews();
    } catch (e) {
      console.error('finalizeDrag failed', e);
      try {
        await refreshVisibleViews();
      } catch {}
    } finally {
      setDraggingId(null);
      setCombineTargetId(null);
      setDragOverlay(null);
      setDropPath(null);
      setDndEpoch((prev) => prev + 1);
    }
  }, [
    draggingId,
    combineTargetId,
    dropPath,
    files,
    columnFiles,
    viewMode,
    refreshVisibleViews,
    getParentPath,
  ]);

  useEffect(() => {
    if (!draggingId) return;
    const onMove = (e: MouseEvent) => {
      setDragPos({ x: e.clientX + 8, y: e.clientY + 8 });
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [draggingId]);

  useEffect(() => {
    const scheduleCleanup = () => {
      if (!draggingId) return;
      finalizeDrag();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') scheduleCleanup();
    };
    window.addEventListener('mouseup', scheduleCleanup);
    window.addEventListener('pointerup', scheduleCleanup);
    window.addEventListener('blur', scheduleCleanup);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('mouseup', scheduleCleanup);
      window.removeEventListener('pointerup', scheduleCleanup);
      window.removeEventListener('blur', scheduleCleanup);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [draggingId, finalizeDrag]);

  return {
    draggingId,
    combineTargetId,
    dragOverlay,
    dragPos,
    dndEpoch,
    beginDrag,
    handleHoverFolder,
    handleHoverContainerPath,
  };
}
