import React, { useRef, useState, useCallback, useMemo, useLayoutEffect, useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import styles from './GridView.module.css';
import { Icon } from './Icon';
import type { IconName } from '../icons';
import { invoke } from '@tauri-apps/api/core';
import { createFolderIn, renamePath } from '../utils/fs';
import type { SortKey, SortDir } from './FileTable';
import { sortFiles } from './FileTable';
import { joinPaths } from '../utils/fs';
import { useDragStart } from '../hooks/useDragStart';
import { useVirtualGrid } from '../hooks/useVirtualGrid';
import { useMarqueeSelection } from '../hooks/useMarqueeSelection';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { renamePath as renameFilePath } from '../utils/fs';
import type { BatchRenameOperation } from '../undoRedoStore';
import { useUndoRedoStore, generateOperationId } from '../undoRedoStore';
import { useToast } from './Toast';
import { deleteWithUndo } from '../utils/fileOperations';
import { reportError } from '../utils/errorReporter';
import type { GetSelectedFilesFunction } from '../hooks/useKeyboardClipboard';

const LazyBatchRenameDialog = React.lazy(() =>
  import('./BatchRenameDialog').then((m) => ({ default: m.BatchRenameDialog }))
);
const LazyArchiveDialog = React.lazy(() =>
  import('./ArchiveDialog').then((m) => ({ default: m.ArchiveDialog }))
);
const LazySecureDeleteDialog = React.lazy(() =>
  import('./SecureDeleteDialog').then((m) => ({ default: m.SecureDeleteDialog }))
);

/**
 * Props for the GridView component.
 */
interface GridViewProps {
  /** Current directory path being displayed */
  currentPath: string;
  /** Array of file entries to display in the grid */
  files: FileEntry[];
  /** Callback fired when a file is selected (single click) */
  onFileSelect?: (file: FileEntry) => void;
  /** Callback fired when a folder is opened (double click or Enter) */
  onFolderOpen?: (folder: FileEntry) => void;
  /** ID of the folder currently being hovered during drag-and-drop */
  dragCombineTargetId?: string | null;
  /** Whether a drag operation is currently in progress */
  isDragging?: boolean;
  /** ID of the item currently being dragged */
  draggingItemId?: string | null;
  /** Callback fired when a drag operation begins */
  onBeginDrag?: (file: FileEntry) => void;
  /** Callback fired when hovering over a folder during drag */
  onHoverFolder?: (file: FileEntry | null) => void;
  /** Callback fired when hovering over the container during drag */
  onHoverContainer?: (path: string) => void;
  /** Ref to register the getSelectedFiles function for keyboard clipboard shortcuts */
  getSelectedFilesRef?: React.MutableRefObject<GetSelectedFilesFunction | null>;
}

// Grid item gap (constant)
const GRID_GAP = 12;
const SORT_WORKER_THRESHOLD = 5000;

// Helper to determine if entry is a directory (prefer explicit flag)
function isDirectory(file: FileEntry): boolean {
  if (typeof file.is_dir === 'boolean') return file.is_dir;
  // Fallback heuristic if flag is missing
  const name = file.path.split(/[/\\]/).pop() || '';
  return file.size === 0 && !name.includes('.');
}

// Helper to get file icon name
function getFileIconName(file: FileEntry): IconName {
  if (isDirectory(file)) return 'folder';
  const ext = file.path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'bmp':
    case 'webp':
      return 'image';
    case 'pdf':
      return 'file';
    case 'doc':
    case 'docx':
      return 'file';
    case 'xls':
    case 'xlsx':
      return 'file';
    case 'ppt':
    case 'pptx':
      return 'file';
    case 'zip':
    case 'rar':
    case '7z':
      return 'archive';
    case 'txt':
    case 'md':
      return 'file';
    case 'mp3':
    case 'wav':
    case 'ogg':
      return 'music';
    case 'mp4':
    case 'avi':
    case 'mov':
    case 'mkv':
      return 'video';
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':
      return 'code';
    case 'html':
    case 'css':
      return 'code';
    case 'json':
      return 'file';
    case 'exe':
      return 'file';
    default:
      return 'file';
  }
}

// Helper to format file size
function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function withDisplayNames(entries: FileEntry[]): FileEntry[] {
  return entries.map((entry) => ({
    ...entry,
    name: entry.name ?? (entry.path.split(/[/\\]/).pop() || entry.path),
  }));
}

type GridSelectionEvent = React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>;

function GridViewInner({
  currentPath,
  files,
  onFileSelect,
  onFolderOpen,
  dragCombineTargetId,
  isDragging,
  draggingItemId,
  onBeginDrag,
  onHoverFolder,
  onHoverContainer,
  getSelectedFilesRef,
}: GridViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Batch state selectors to reduce re-renders
  const {
    showHidden,
    sortKey,
    sortDir,
    filterMode,
    searchQuery,
    draftNew,
    editingId,
    gridMinWidth,
    density,
    uiScale,
    clipboard,
    confirmBeforeDelete,
  } = useFileStore(
    useShallow((s) => ({
      showHidden: s.showHidden,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
      filterMode: s.filterMode,
      searchQuery: s.searchQuery,
      draftNew: s.draftNew,
      editingId: s.editingId,
      gridMinWidth: s.gridMinWidth,
      density: s.density,
      uiScale: s.uiScale,
      clipboard: s.clipboard,
      confirmBeforeDelete: s.confirmBeforeDelete,
    }))
  );

  // Calculate grid item dimensions based on gridMinWidth from store
  const gridItemWidth = gridMinWidth;
  const gridItemHeight = Math.round(gridMinWidth * 0.85); // Maintain aspect ratio

  // Action selectors (stable references)
  const setEditingId = useFileStore((s) => s.setEditingId);
  const setDraftNew = useFileStore((s) => s.setDraftNew);
  const setFiles = useFileStore((s) => s.setFiles);
  const pendingSelectPathRef = useRef<string | null>(null);

  // runs after sorted files computed; selects/scrolls to pending path
  const [isOver, setIsOver] = useState(false);
  const dragStart = useDragStart({ onBeginDrag, isEnabled: !!onBeginDrag });
  const contextMenu = useContextMenu();

  const [contentOffset, setContentOffset] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof window === 'undefined') return;
    const style = window.getComputedStyle(el);
    const left = parseFloat(style.paddingLeft) || 0;
    const top = parseFloat(style.paddingTop) || 0;
    setContentOffset({ left, top });
  }, [density, uiScale]);

  const setConfirmBeforeDelete = useFileStore((s) => s.setConfirmBeforeDelete);
  const { show: showToast } = useToast();

  // Delete confirmation state (supports multiple files)
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; files: FileEntry[] }>({
    open: false,
    files: [],
  });

  // Batch rename state
  const [batchRename, setBatchRename] = useState<{ open: boolean; files: FileEntry[] }>({
    open: false,
    files: [],
  });

  // Archive dialog state
  const [archiveDialog, setArchiveDialog] = useState<{
    open: boolean;
    mode: 'compress' | 'extract';
    files: FileEntry[];
  }>({ open: false, mode: 'compress', files: [] });

  // Defensive: ensure files is an array
  const safeFiles = useMemo<FileEntry[]>(() => (Array.isArray(files) ? files : []), [files]);

  const isHidden = useCallback((file: FileEntry) => {
    if (file.hidden === true) return true;
    const name = file.path.split(/[\\/\\]/).pop() || '';
    return name.startsWith('.');
  }, []);

  const filteredFiles = useMemo(() => {
    const base = showHidden ? safeFiles : safeFiles.filter((f) => !isHidden(f));
    const byMode =
      filterMode === 'folders'
        ? base.filter((f) => f.is_dir)
        : filterMode === 'files'
          ? base.filter((f) => !f.is_dir)
          : base;
    const q = (searchQuery || '').trim().toLowerCase();
    let bySearch = !q
      ? byMode
      : byMode.filter((f) => {
          const name = f.name || f.path.split(/[/\\]/).pop() || f.path;
          return name.toLowerCase().includes(q);
        });
    // Inject draft new folder for this container path
    if (draftNew && draftNew.parentPath === currentPath) {
      const draft: FileEntry = {
        id: draftNew.id,
        path: joinPaths(currentPath, draftNew.name),
        name: draftNew.name,
        size: 0,
        modified: new Date().toISOString(),
        hidden: false,
        is_dir: true,
        custom: {},
        is_draft: true,
      };
      if (!bySearch.some((f) => f.id === draft.id)) bySearch = [draft, ...bySearch];
    }
    return bySearch;
  }, [showHidden, safeFiles, filterMode, searchQuery, draftNew, currentPath, isHidden]);

  const [sortedFiles, setSortedFiles] = useState<FileEntry[]>(filteredFiles);

  React.useEffect(() => {
    let cancelled = false;
    const count = filteredFiles.length;
    if (count === 0) {
      setSortedFiles([]);
      return;
    }
    if (count >= SORT_WORKER_THRESHOLD) {
      try {
        const worker = new Worker(new URL('../workers/sortWorker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (ev: MessageEvent<FileEntry[]>) => {
          if (cancelled) return;
          setSortedFiles(ev.data);
          worker.terminate();
        };
        worker.onerror = () => {
          if (!cancelled) {
            setSortedFiles(sortFiles(filteredFiles, sortKey as SortKey, sortDir as SortDir));
          }
          worker.terminate();
        };
        worker.postMessage({ files: filteredFiles, key: String(sortKey), dir: sortDir });
        return () => {
          cancelled = true;
          try {
            worker.terminate();
          } catch {}
        };
      } catch {
        setSortedFiles(sortFiles(filteredFiles, sortKey as SortKey, sortDir as SortDir));
      }
    } else {
      setSortedFiles(sortFiles(filteredFiles, sortKey as SortKey, sortDir as SortDir));
    }
    return () => {
      cancelled = true;
    };
  }, [filteredFiles, sortKey, sortDir]);

  // Register getSelectedFiles for keyboard clipboard shortcuts
  useEffect(() => {
    if (getSelectedFilesRef) {
      getSelectedFilesRef.current = () => {
        return sortedFiles.filter((f) => selectedIds.has(f.id));
      };
    }
    return () => {
      if (getSelectedFilesRef) {
        getSelectedFilesRef.current = null;
      }
    };
  }, [getSelectedFilesRef, sortedFiles, selectedIds]);

  // Virtualization
  const { totalHeight, columnCount, virtualRows, getRowItems } = useVirtualGrid({
    count: sortedFiles.length,
    parentRef: containerRef as React.RefObject<HTMLElement>,
    itemWidth: gridItemWidth,
    itemHeight: gridItemHeight,
    gap: GRID_GAP,
    freeze: isDragging,
  });

  const visibleItemIndices = useMemo(() => {
    const items: number[] = [];
    for (const row of virtualRows) {
      items.push(...getRowItems(row.index));
    }
    return items;
  }, [virtualRows, getRowItems]);

  const gridStartOffset = virtualRows.length > 0 ? virtualRows[0].start : 0;

  // Marquee selection
  const getItemRect = useCallback(
    (index: number) => {
      if (index < 0 || index >= sortedFiles.length) return null;
      const rowIndex = Math.floor(index / columnCount);
      const colIndex = index % columnCount;
      const rowHeight = gridItemHeight + GRID_GAP;
      const left = contentOffset.left + colIndex * (gridItemWidth + GRID_GAP);
      const top = contentOffset.top + rowIndex * rowHeight;
      return {
        left,
        top,
        right: left + gridItemWidth,
        bottom: top + gridItemHeight,
      };
    },
    [sortedFiles.length, columnCount, gridItemWidth, gridItemHeight, contentOffset]
  );

  const getItemId = useCallback(
    (index: number) => {
      return sortedFiles[index]?.id ?? '';
    },
    [sortedFiles]
  );

  const handleMarqueeSelectionChange = useCallback((ids: Set<string>, additive: boolean) => {
    if (additive) {
      // Add to existing selection
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
    } else {
      setSelectedIds(ids);
    }
  }, []);

  const handleEmptyClick = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorIndex(null);
    setCursorIndex(null);
  }, []);

  const marquee = useMarqueeSelection({
    containerRef: containerRef as React.RefObject<HTMLElement>,
    getItemRect,
    itemCount: sortedFiles.length,
    getItemId,
    onSelectionChange: handleMarqueeSelectionChange,
    enabled: !isDragging,
    itemSelector: `.${styles.gridItem}`,
    onEmptyClick: handleEmptyClick,
  });

  React.useEffect(() => {
    const target = pendingSelectPathRef.current;
    if (!target) return;
    const idx = sortedFiles.findIndex((f) => f.path === target);
    if (idx >= 0) {
      const id = sortedFiles[idx].id;
      setSelectedIds(new Set([id]));
      setAnchorIndex(idx);
      setCursorIndex(idx);
      const el = containerRef.current?.querySelector(
        `[data-file-id="${CSS.escape(id)}"]`
      ) as HTMLElement | null;
      if (el) el.scrollIntoView({ block: 'nearest' });
      pendingSelectPathRef.current = null;
    }
  }, [sortedFiles]);

  const handleItemClick = useCallback(
    (e: GridSelectionEvent, index: number, file: FileEntry) => {
      const isRange = e.shiftKey;
      const isToggle = e.ctrlKey || e.metaKey;
      const next = new Set(selectedIds);
      if (isRange) {
        const filesArr = sortedFiles;
        const anchor = anchorIndex ?? index;
        const start = Math.min(anchor, index);
        const end = Math.max(anchor, index);
        next.clear();
        for (let i = start; i <= end; i++) next.add(filesArr[i].id);
        setAnchorIndex(index);
      } else if (isToggle) {
        if (next.has(file.id)) next.delete(file.id);
        else next.add(file.id);
        setAnchorIndex(index);
      } else {
        next.clear();
        next.add(file.id);
        setAnchorIndex(index);
      }
      setSelectedIds(next);
      setCursorIndex(index);
      onFileSelect?.(file);
    },
    [selectedIds, anchorIndex, sortedFiles, onFileSelect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const all = new Set(sortedFiles.map((f) => f.id));
        setSelectedIds(all);
        setAnchorIndex(sortedFiles.length ? 0 : null);
        setCursorIndex(sortedFiles.length ? 0 : null);
      } else if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setAnchorIndex(null);
        setCursorIndex(null);
      } else if (e.key === 'F2') {
        // rename first selected item
        const firstSel = selectedIds.values().next().value as string | undefined;
        if (firstSel) {
          e.preventDefault();
          setEditingId(firstSel);
        }
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const perRow = columnCount;
        const current =
          cursorIndex ??
          (selectedIds.size ? sortedFiles.findIndex((f) => selectedIds.has(f.id)) : -1);
        let nextIdx = current >= 0 ? current : 0;
        switch (e.key) {
          case 'ArrowLeft':
            nextIdx = Math.max(0, nextIdx - 1);
            break;
          case 'ArrowRight':
            nextIdx = Math.min(sortedFiles.length - 1, nextIdx + 1);
            break;
          case 'ArrowUp':
            nextIdx = Math.max(0, nextIdx - perRow);
            break;
          case 'ArrowDown':
            nextIdx = Math.min(sortedFiles.length - 1, nextIdx + perRow);
            break;
        }
        if (e.shiftKey) {
          const anchor = anchorIndex ?? cursorIndex ?? nextIdx;
          const a = Math.min(anchor, nextIdx);
          const b = Math.max(anchor, nextIdx);
          const range = new Set<string>();
          for (let i = a; i <= b; i++) range.add(sortedFiles[i].id);
          setSelectedIds(range);
          setCursorIndex(nextIdx);
        } else {
          setSelectedIds(new Set([sortedFiles[nextIdx].id]));
          setAnchorIndex(nextIdx);
          setCursorIndex(nextIdx);
        }
      }
    },
    [sortedFiles, selectedIds, anchorIndex, cursorIndex, columnCount, setEditingId]
  );

  // Global ESC handler to clear selection even without focus
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setSelectedIds(new Set());
        setAnchorIndex(null);
        setCursorIndex(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleRename = useCallback(
    async (file: FileEntry, committed: boolean, newName?: string) => {
      try {
        if (!committed) {
          if (file.is_draft) setDraftNew(null);
          setEditingId(null);
          return;
        }
        const name = (newName || '').trim();
        if (!name) {
          if (file.is_draft) setDraftNew(null);
          setEditingId(null);
          return;
        }
        if (file.is_draft) {
          const created = await createFolderIn(currentPath, name);
          pendingSelectPathRef.current = created;
          setDraftNew(null);
        } else {
          const newPath = await renamePath(file.path, name);
          pendingSelectPathRef.current = newPath;
        }
        const res = await invoke<FileEntry[]>('list_files', {
          path: currentPath,
          calc_dir_size: false,
        });
        setFiles(withDisplayNames(res));
      } finally {
        setEditingId(null);
      }
    },
    [currentPath, setDraftNew, setEditingId, setFiles]
  );

  const performDelete = useCallback(
    async (files: FileEntry[], permanent: boolean = false) => {
      try {
        const refresh = async () => {
          const res = await invoke<FileEntry[]>('list_files', {
            path: currentPath,
            calc_dir_size: false,
          });
          setFiles(withDisplayNames(res));
        };
        const success = await deleteWithUndo(files, showToast, refresh, { permanent });
        if (success) {
          setSelectedIds(new Set());
        }
      } catch (e) {
        reportError('Delete failed', e, { toast: showToast });
      }
    },
    [currentPath, setFiles, showToast]
  );

  const handleDeleteConfirm = useCallback(
    (permanent: boolean) => {
      if (deleteConfirm.files.length > 0) {
        performDelete(deleteConfirm.files, permanent);
      }
      setDeleteConfirm({ open: false, files: [] });
    },
    [deleteConfirm.files, performDelete]
  );

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirm({ open: false, files: [] });
  }, []);

  const handleDontAskAgain = useCallback(
    (checked: boolean) => {
      if (checked) {
        setConfirmBeforeDelete(false);
      }
    },
    [setConfirmBeforeDelete]
  );

  // Batch rename handlers
  const handleBatchRename = useCallback((files: FileEntry[]) => {
    setBatchRename({ open: true, files });
  }, []);

  const handleBatchRenameApply = useCallback(
    async (renames: { oldPath: string; newName: string }[]) => {
      try {
        const completedRenames: Array<{
          oldPath: string;
          newPath: string;
          oldName: string;
          newName: string;
        }> = [];

        for (const { oldPath, newName } of renames) {
          const oldName = oldPath.split(/[/\\]/).pop() || '';
          const parentPath = oldPath.replace(/[\\/][^\\/]+$/, '');
          const newPath = `${parentPath}/${newName}`;

          await renameFilePath(oldPath, newName);
          completedRenames.push({ oldPath, newPath, oldName, newName });
        }

        // Register batch rename operation for undo
        if (completedRenames.length > 0) {
          const pushOp = useUndoRedoStore.getState().push;
          const operation: BatchRenameOperation = {
            id: generateOperationId(),
            type: 'batch_rename',
            timestamp: Date.now(),
            description: `Renamed ${completedRenames.length} file${completedRenames.length > 1 ? 's' : ''}`,
            renames: completedRenames,
            successCount: completedRenames.length,
            undo: async () => {
              // Undo: rename files back to original names (in reverse order)
              try {
                for (let i = completedRenames.length - 1; i >= 0; i--) {
                  const { newPath, oldName } = completedRenames[i];
                  await renameFilePath(newPath, oldName);
                }
                return true;
              } catch (e) {
                reportError('Batch rename undo failed', e, { toast: showToast });
                return false;
              }
            },
            redo: async () => {
              // Redo: rename files again to new names
              try {
                for (const { oldPath, newName } of completedRenames) {
                  await renameFilePath(oldPath, newName);
                }
                return true;
              } catch (e) {
                reportError('Batch rename redo failed', e, { toast: showToast });
                return false;
              }
            },
          };
          pushOp(operation);
        }

        // Refresh file list
        const res = await invoke<FileEntry[]>('list_files', {
          path: currentPath,
          calc_dir_size: false,
        });
        setFiles(withDisplayNames(res));
        // Clear selection after rename
        setSelectedIds(new Set());
      } catch (e) {
        reportError('Batch rename failed', e, { toast: showToast });
        throw e;
      }
    },
    [currentPath, setFiles, showToast]
  );

  const handleBatchRenameClose = useCallback(() => {
    setBatchRename({ open: false, files: [] });
  }, []);

  // Archive handlers
  const handleCompress = useCallback((files: FileEntry[]) => {
    setArchiveDialog({ open: true, mode: 'compress', files });
  }, []);

  const handleExtract = useCallback((file: FileEntry) => {
    setArchiveDialog({ open: true, mode: 'extract', files: [file] });
  }, []);

  const handleArchiveClose = useCallback(() => {
    setArchiveDialog({ open: false, mode: 'compress', files: [] });
  }, []);

  const handleArchiveSuccess = useCallback(async () => {
    // Refresh file list after archive operation
    const res = await invoke<FileEntry[]>('list_files', {
      path: currentPath,
      calc_dir_size: false,
    });
    setFiles(withDisplayNames(res));
    setArchiveDialog({ open: false, mode: 'compress', files: [] });
  }, [currentPath, setFiles]);

  if (sortedFiles.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyStateIcon}>
          <Icon name="folder" size={20} />
        </div>
        <div className={styles.emptyStateText}>This folder is empty</div>
        <div className={styles.emptyStateSubtext}>Drop files here or use the create button</div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`${styles.gridContainer} ${isDragging && isOver ? styles.droppableOver : ''}`}
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => {
          if (clipboard) contextMenu.openForEmpty(e, currentPath);
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest(`.${styles.gridItem}`)) return; // clicking an item
          // Start marquee selection (it handles clearing selection internally)
          marquee.onMouseDown(e);
          setAnchorIndex(null);
          setCursorIndex(null);
          onHoverFolder?.(null);
        }}
        onMouseEnter={() => {
          setIsOver(true);
          if (isDragging) onHoverContainer?.(currentPath);
        }}
        onMouseLeave={() => setIsOver(false)}
      >
        {/* Virtualized content container */}
        <div
          style={{
            height: totalHeight,
            width: '100%',
            position: 'relative',
          }}
        >
          {/* Marquee selection overlay */}
          {marquee.isActive && marquee.rect && (
            <div
              className={styles.marquee}
              style={{
                position: 'absolute',
                left: marquee.rect.left - contentOffset.left,
                top: marquee.rect.top - contentOffset.top,
                width: marquee.rect.width,
                height: marquee.rect.height,
                pointerEvents: 'none',
              }}
            />
          )}
          {visibleItemIndices.length > 0 && (
            <div
              className={styles.gridContent}
              style={{
                top: gridStartOffset,
                gridTemplateColumns: `repeat(${columnCount}, ${gridItemWidth}px)`,
                gap: GRID_GAP,
                gridAutoRows: gridItemHeight,
              }}
            >
              {visibleItemIndices.map((itemIndex) => {
                const file = sortedFiles[itemIndex];
                if (!file) return null;

                const isFolder = isDirectory(file);
                const fileName = file.path.split(/[/\\]/).pop() || file.path;
                const isSource = draggingItemId === file.id;
                const itemStyle: React.CSSProperties = isFolder
                  ? {
                      backgroundImage:
                        'linear-gradient(0deg, rgba(255,255,255,0.03), rgba(255,255,255,0.03))',
                    }
                  : {};

                return (
                  <div
                    key={file.id}
                    data-file-id={file.id}
                    className={`
                    ${styles.gridItem}
                    ${isFolder ? styles.folder : styles.file}
                    ${selectedIds.has(file.id) ? styles.selected : ''}
                    ${isSource ? styles.dragSource : ''}
                    ${dragCombineTargetId === file.id && isFolder ? styles.dropTarget : ''}
                  `}
                    style={{
                      ...(isSource ? { pointerEvents: 'none' } : {}),
                      ...itemStyle,
                      width: gridItemWidth,
                      minWidth: gridItemWidth,
                    }}
                    tabIndex={0}
                    aria-label={isFolder ? `Open folder ${fileName}` : `Select file ${fileName}`}
                    onClick={(e) => handleItemClick(e, itemIndex, file)}
                    onDoubleClick={() => {
                      if (isFolder) onFolderOpen?.(file);
                      else
                        invoke('open_path', { path: file.path }).catch((err) =>
                          console.error('open_path failed', err)
                        );
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        if (isFolder) onFolderOpen?.(file);
                        else
                          invoke('open_path', { path: file.path }).catch((err) =>
                            console.error('open_path failed', err)
                          );
                      } else if (e.key === ' ') {
                        handleItemClick(e, itemIndex, file);
                      }
                    }}
                    onMouseDown={(e) => dragStart.onMouseDown(e, file)}
                    onMouseEnter={() => {
                      if (isDragging) {
                        if (isFolder && !isSource) onHoverFolder?.(file);
                        else onHoverFolder?.(null);
                      }
                    }}
                    onContextMenu={(e) => {
                      // If clicked file is in selection, use all selected files; otherwise just this file
                      const clickedInSelection = selectedIds.has(file.id);
                      const targetFiles = clickedInSelection
                        ? sortedFiles.filter((f) => selectedIds.has(f.id))
                        : [file];
                      contextMenu.openForFiles(e, targetFiles, currentPath);
                    }}
                    onMouseLeave={() => {
                      if (isDragging) onHoverFolder?.(null);
                    }}
                  >
                    <span className={styles.fileIcon}>
                      <Icon name={getFileIconName(file)} />
                    </span>
                    {editingId === file.id ? (
                      <InlineRenameGrid
                        key={`edit:${file.id}`}
                        file={file}
                        onDone={(committed, newName) => handleRename(file, committed, newName)}
                      />
                    ) : (
                      <span className={styles.fileName} title={fileName}>
                        {fileName}
                      </span>
                    )}
                    <span className={styles.fileSize}>{formatBytes(file.size)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <ContextMenu
        state={contextMenu.state}
        onClose={contextMenu.close}
        onRename={(file) => setEditingId(file.id)}
        onBatchRename={handleBatchRename}
        onRefresh={async () => {
          const res = await invoke<FileEntry[]>('list_files', {
            path: currentPath,
            calc_dir_size: false,
          });
          setFiles(withDisplayNames(res));
        }}
        confirmBeforeDelete={confirmBeforeDelete}
        onDeleteConfirm={(files) => setDeleteConfirm({ open: true, files })}
        onCompress={handleCompress}
        onExtract={handleExtract}
      />
      {deleteConfirm.open && (
        <React.Suspense fallback={null}>
          <LazySecureDeleteDialog
            open={deleteConfirm.open}
            files={deleteConfirm.files}
            onConfirm={handleDeleteConfirm}
            onCancel={handleDeleteCancel}
            showDontAskAgain
            onDontAskAgainChange={handleDontAskAgain}
          />
        </React.Suspense>
      )}
      {batchRename.open && (
        <React.Suspense fallback={null}>
          <LazyBatchRenameDialog
            open={batchRename.open}
            files={batchRename.files}
            onClose={handleBatchRenameClose}
            onApply={handleBatchRenameApply}
          />
        </React.Suspense>
      )}
      {archiveDialog.open && (
        <React.Suspense fallback={null}>
          <LazyArchiveDialog
            open={archiveDialog.open}
            mode={archiveDialog.mode}
            files={archiveDialog.files}
            currentPath={currentPath}
            onClose={handleArchiveClose}
            onSuccess={handleArchiveSuccess}
          />
        </React.Suspense>
      )}
    </>
  );
}

/**
 * GridView displays files as a responsive grid of thumbnails/icons.
 *
 * Features:
 * - Responsive grid layout that adapts to container width
 * - Thumbnail previews for images and videos
 * - Virtual scrolling for large directories
 * - Marquee (rubber band) selection
 * - Multi-select with Shift/Ctrl modifiers
 * - Drag-and-drop support for file operations
 * - Context menu integration
 * - Keyboard navigation (arrow keys, Enter to open)
 * - Configurable minimum item width via store
 *
 * @example
 * ```tsx
 * <GridView
 *   currentPath="/Users/me/Pictures"
 *   files={entries}
 *   onFileSelect={(file) => setSelected(file)}
 *   onFolderOpen={(folder) => navigate(folder.path)}
 * />
 * ```
 */
export const GridView = React.memo(GridViewInner);

function InlineRenameGrid({
  file,
  onDone,
}: {
  file: FileEntry;
  onDone: (committed: boolean, newName?: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [value, setValue] = React.useState<string>(
    () => file.name ?? (file.path.split(/[/\\]/).pop() || file.path)
  );
  React.useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);
  const commit = () => onDone(true, value);
  const cancel = () => onDone(false);
  return (
    <input
      ref={inputRef}
      className={styles.fileName}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      }}
    />
  );
}
