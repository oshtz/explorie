import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../store';
import type { ViewMode } from '../components/ViewModeToggle';
import type { DragPoint } from './useDragStart';
import { basename, normalizePath } from '../utils/path';
import {
  copyWithUndoAndConflictResolution,
  moveWithUndoAndConflictResolution,
  type ShowToastFn,
} from '../utils/fileOperations';
import { reportError } from '../utils/errorReporter';

export type DragOperation = 'copy' | 'move';
export type DragOverlayPhase = 'gathering' | 'dragging' | 'dropping' | 'returning';
export type DragOverlayItem = {
  id: string;
  label: string;
  icon: string;
  origin: DragPoint;
};
export type DragOverlayState = {
  items: DragOverlayItem[];
  totalCount: number;
  pickupPoint: DragPoint;
  releasePoint: DragPoint | null;
  phase: DragOverlayPhase;
  destination: DragPoint | null;
  operation: DragOperation;
};

type UseFileDragAndDropOptions = {
  files: FileEntry[];
  columnFiles: { [path: string]: FileEntry[] };
  viewMode: ViewMode;
  selectedPaths: string[];
  setSelectedPaths: (paths: string[]) => void;
  refreshVisibleViews: () => Promise<void>;
  getParentPath: (path: string) => string;
  showToast: ShowToastFn;
  addFavorite: (path: string, name?: string) => void;
  onOpenFolder: (folder: FileEntry) => void;
};

const MAX_VISIBLE_DRAG_ITEMS = 4;

function comparablePath(path: string): string {
  const normalized = normalizePath(path).replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isValidDropTarget(
  targetPath: string,
  entries: FileEntry[],
  getParentPath: (path: string) => string,
  operation: DragOperation = 'move'
): boolean {
  if (entries.length === 0) return false;
  const target = comparablePath(targetPath);
  if (
    operation === 'move' &&
    entries.every((entry) => target === comparablePath(getParentPath(entry.path)))
  ) {
    return false;
  }
  return entries.every((entry) => {
    const source = comparablePath(entry.path);
    return target !== source && (!entry.is_dir || !target.startsWith(`${source}/`));
  });
}

function iconFor(entry: FileEntry): string {
  if (entry.is_dir) return 'folder';
  const ext = (entry.name ?? basename(entry.path)).split('.').pop()?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext ?? '')) return 'image';
  if (['mp4', 'avi', 'mov', 'mkv'].includes(ext ?? '')) return 'video';
  if (['mp3', 'wav', 'ogg'].includes(ext ?? '')) return 'music';
  if (['zip', 'rar', '7z'].includes(ext ?? '')) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'html', 'css'].includes(ext ?? '')) return 'code';
  return 'file';
}

function findFileElement(id: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-file-id]')).find(
      (element) => element.dataset.fileId === id
    ) ?? null
  );
}

function elementCenter(id: string): DragPoint | null {
  const rect = findFileElement(id)?.getBoundingClientRect();
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

function findScrollableTarget(x: number, y: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  let target = document.elementFromPoint(x, y) as HTMLElement | null;
  while (target) {
    if (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth) {
      return target;
    }
    target = target.parentElement;
  }
  return null;
}

export function useFileDragAndDrop({
  files,
  columnFiles,
  selectedPaths,
  setSelectedPaths,
  refreshVisibleViews,
  getParentPath,
  showToast,
  addFavorite,
  onOpenFolder,
}: UseFileDragAndDropOptions) {
  const [draggingItemIds, setDraggingItemIds] = useState<ReadonlySet<string>>(new Set());
  const [combineTargetId, setCombineTargetId] = useState<string | null>(null);
  const [dragOverlay, setDragOverlay] = useState<DragOverlayState | null>(null);
  const [dragPos, setDragPos] = useState<DragPoint>({ x: 0, y: 0 });
  const [operation, setOperation] = useState<DragOperation>('move');
  const [dndEpoch, setDndEpoch] = useState(0);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [pinToFavorites, setPinToFavorites] = useState(false);
  const finalizingRef = useRef(false);
  const draggedEntriesRef = useRef<FileEntry[]>([]);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef<DragPoint>({ x: 0, y: 0 });

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearHoverTimer();
    draggedEntriesRef.current = [];
    setDraggingItemIds(new Set());
    setCombineTargetId(null);
    setDragOverlay(null);
    setDropPath(null);
    setPinToFavorites(false);
    setOperation('move');
    setDndEpoch((value) => value + 1);
  }, [clearHoverTimer]);

  const beginDrag = useCallback(
    (entry: FileEntry, point: DragPoint, selectedEntries: FileEntry[] = []) => {
      finalizingRef.current = false;
      pointerRef.current = point;
      const allEntries = [files, ...Object.values(columnFiles)].flat();
      const selected = new Set(selectedPaths);
      const knownSelected = allEntries.filter((file, index, all) => {
        return (
          selected.has(file.path) &&
          all.findIndex((candidate) => candidate.path === file.path) === index
        );
      });
      const entryIsSelected = selected.has(entry.path);
      const suppliedSelection = selectedEntries.some((file) => file.path === entry.path)
        ? selectedEntries
        : [];
      const dragged = suppliedSelection.length
        ? suppliedSelection
        : entryIsSelected
          ? [entry, ...knownSelected.filter((file) => file.path !== entry.path)]
          : [entry];
      if (!entryIsSelected) setSelectedPaths([entry.path]);

      draggedEntriesRef.current = dragged;
      setDraggingItemIds(new Set(dragged.map((file) => file.id)));
      setDragPos(point);
      setOperation('move');
      setCombineTargetId(null);
      setDropPath(null);
      setPinToFavorites(false);

      const items: DragOverlayItem[] = [];
      for (const file of dragged) {
        const origin = elementCenter(file.id);
        if (!origin) continue;
        items.push({
          id: file.id,
          label: file.name ?? basename(file.path),
          icon: iconFor(file),
          origin,
        });
        if (items.length === MAX_VISIBLE_DRAG_ITEMS) break;
      }
      if (items.length === 0) {
        items.push({
          id: entry.id,
          label: entry.name ?? basename(entry.path),
          icon: iconFor(entry),
          origin: point,
        });
      }
      setDragOverlay({
        items,
        totalCount: dragged.length,
        pickupPoint: point,
        releasePoint: null,
        phase: 'gathering',
        destination: null,
        operation: 'move',
      });
    },
    [columnFiles, files, selectedPaths, setSelectedPaths]
  );

  const handleHoverFolder = useCallback(
    (file: FileEntry | null) => {
      clearHoverTimer();
      setPinToFavorites(false);
      if (
        !file ||
        !isValidDropTarget(file.path, draggedEntriesRef.current, getParentPath, operation)
      ) {
        setCombineTargetId(null);
        setDropPath(null);
        return;
      }
      setCombineTargetId(file.id);
      setDropPath(file.path);
      hoverTimerRef.current = setTimeout(() => {
        onOpenFolder(file);
        setCombineTargetId(null);
        setDropPath(file.path);
      }, 700);
    },
    [clearHoverTimer, getParentPath, onOpenFolder, operation]
  );

  const handleHoverContainerPath = useCallback(
    (path: string | null) => {
      clearHoverTimer();
      setCombineTargetId(null);
      setDropPath(path);
      setPinToFavorites(false);
    },
    [clearHoverTimer]
  );

  const handleHoverFavorites = useCallback(() => {
    clearHoverTimer();
    setCombineTargetId(null);
    setDropPath(null);
    setPinToFavorites(true);
  }, [clearHoverTimer]);

  const handleGatherComplete = useCallback(() => {
    setDragOverlay((current) =>
      current?.phase === 'gathering' ? { ...current, phase: 'dragging' } : current
    );
  }, []);

  const handleDragAnimationComplete = useCallback(() => reset(), [reset]);

  const finalizeDrag = useCallback(() => {
    const dragged = draggedEntriesRef.current;
    if (dragged.length === 0 || finalizingRef.current) return;
    finalizingRef.current = true;
    clearHoverTimer();
    const releasePoint = pointerRef.current;

    if (pinToFavorites) {
      const folders = dragged.filter((entry) => entry.is_dir);
      showToast(
        folders.length
          ? `Added ${folders.length === 1 ? (folders[0].name ?? basename(folders[0].path)) : `${folders.length} folders`} to Favorites`
          : 'Only folders can be added to Favorites',
        { type: folders.length ? 'success' : 'warning' }
      );
      if (!folders.length) {
        setDragOverlay((current) =>
          current ? { ...current, phase: 'returning', releasePoint } : current
        );
        return;
      }
      folders.forEach((folder) => addFavorite(folder.path, folder.name));
      setDragOverlay((current) =>
        current ? { ...current, phase: 'dropping', releasePoint, destination: null } : current
      );
      return;
    }

    if (!dropPath || !isValidDropTarget(dropPath, dragged, getParentPath, operation)) {
      const target = dropPath ? comparablePath(dropPath) : null;
      if (
        target &&
        dragged.some((entry) => {
          const source = comparablePath(entry.path);
          return entry.is_dir && (target === source || target.startsWith(`${source}/`));
        })
      ) {
        showToast('A folder cannot be dropped into itself', { type: 'warning' });
      }
      setDragOverlay((current) =>
        current ? { ...current, phase: 'returning', releasePoint, destination: null } : current
      );
      return;
    }

    const destination = combineTargetId ? elementCenter(combineTargetId) : null;
    const targetPath = dropPath;
    const entries =
      operation === 'copy'
        ? [...dragged]
        : dragged.filter(
            (entry) => comparablePath(getParentPath(entry.path)) !== comparablePath(targetPath)
          );
    setCombineTargetId(null);
    setDropPath(null);
    setDragOverlay((current) =>
      current ? { ...current, phase: 'dropping', releasePoint, destination } : current
    );

    const mutate =
      operation === 'copy' ? copyWithUndoAndConflictResolution : moveWithUndoAndConflictResolution;
    void mutate(entries, targetPath, showToast, refreshVisibleViews, {
      conflictResolution: 'ask',
    }).catch(async (error) => {
      reportError(`${operation === 'copy' ? 'Copy' : 'Move'} failed`, error, {
        toast: showToast,
      });
      await refreshVisibleViews().catch(() => undefined);
    });
  }, [
    addFavorite,
    clearHoverTimer,
    combineTargetId,
    dropPath,
    getParentPath,
    operation,
    pinToFavorites,
    refreshVisibleViews,
    showToast,
  ]);

  const dragPhase = dragOverlay?.phase;

  useEffect(() => {
    if (
      draggingItemIds.size === 0 ||
      !dragPhase ||
      !['gathering', 'dragging'].includes(dragPhase)
    ) {
      return;
    }
    let frame = 0;
    let pending: DragPoint | null = null;
    const updateOperation = (event: MouseEvent | KeyboardEvent) => {
      const next: DragOperation = event.ctrlKey || event.altKey ? 'copy' : 'move';
      setOperation((current) => (current === next ? current : next));
      setDragOverlay((current) =>
        current && current.operation !== next ? { ...current, operation: next } : current
      );
    };
    const onMove = (event: MouseEvent) => {
      pending = { x: event.clientX, y: event.clientY };
      pointerRef.current = pending;
      updateOperation(event);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!pending) return;
        setDragPos(pending);
        pending = null;
      });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('keydown', updateOperation);
    window.addEventListener('keyup', updateOperation);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', updateOperation);
      window.removeEventListener('keyup', updateOperation);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [dragPhase, draggingItemIds]);

  useEffect(() => {
    if (
      draggingItemIds.size === 0 ||
      !dragPhase ||
      !['gathering', 'dragging'].includes(dragPhase)
    ) {
      return;
    }
    let frame = 0;
    const tick = () => {
      const { x, y } = pointerRef.current;
      const target = findScrollableTarget(x, y);
      if (target) {
        const rect = target.getBoundingClientRect();
        const edge = 36;
        const left = x < rect.left + edge ? -16 : x > rect.right - edge ? 16 : 0;
        const top = y < rect.top + edge ? -16 : y > rect.bottom - edge ? 16 : 0;
        if (left || top) target.scrollBy({ left, top });
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [dragPhase, draggingItemIds]);

  useEffect(() => {
    if (draggingItemIds.size === 0) return;
    const release = () => finalizeDrag();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [draggingItemIds, finalizeDrag]);

  return {
    draggingItemIds,
    combineTargetId,
    dragOverlay,
    dragPos,
    dndEpoch,
    beginDrag,
    handleHoverFolder,
    handleHoverContainerPath,
    handleHoverFavorites,
    handleGatherComplete,
    handleDragAnimationComplete,
  };
}
