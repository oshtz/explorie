import React, { useState, useMemo, useCallback, useRef, useId, useEffect } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { renamePath, createFolderIn } from '../utils/fs';
import styles from './FileTable.module.css';
import { Icon } from './Icon';
import type { IconName } from '../icons';
import { invoke } from '@tauri-apps/api/core';
import { parseToMs, formatLocalDate } from '../utils/date';
import { getCustomColumns } from '../utils/customColumns';
import { useVirtualRows } from '../hooks/useVirtualRows';
import { useDragStart } from '../hooks/useDragStart';
import { useMarqueeSelection } from '../hooks/useMarqueeSelection';
import { ContextMenu, useContextMenu } from './ContextMenu';
import type { BatchRenameOperation } from '../undoRedoStore';
import { useUndoRedoStore, generateOperationId } from '../undoRedoStore';
import { useToast } from './Toast';
import { reportError } from '../utils/errorReporter';
import { deleteWithUndo } from '../utils/fileOperations';
import { getSortableColumnProps, announceSelection } from '../utils/accessibility';
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
 * Sort key for file table columns.
 * Built-in keys: "name", "size", "modified"
 * Custom field keys can be any string matching a field in FileEntry.custom
 */
export type SortKey = 'name' | 'size' | 'modified' | string;

/** Sort direction: ascending or descending */
export type SortDir = 'asc' | 'desc';

/**
 * Sorts an array of file entries by the specified key and direction.
 * Handles special cases like draft items (always on top) and custom fields.
 *
 * @param files - Array of file entries to sort
 * @param key - Column key to sort by (name, size, modified, or custom field)
 * @param dir - Sort direction (asc or desc)
 * @returns New sorted array (original is not mutated)
 *
 * @example
 * ```ts
 * const sorted = sortFiles(files, "name", "asc");
 * const bySize = sortFiles(files, "size", "desc");
 * const byCustom = sortFiles(files, "priority", "asc"); // custom field
 * ```
 */
export function sortFiles(files: FileEntry[], key: SortKey, dir: SortDir): FileEntry[] {
  const sorted = [...files];
  sorted.sort((a, b) => {
    // Draft items stay on top regardless of sort
    const ad = a.is_draft === true;
    const bd = b.is_draft === true;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (key === 'name') {
      const aName = a.name ?? (a.path.split(/[/\\]/).pop() || '');
      const bName = b.name ?? (b.path.split(/[/\\]/).pop() || '');
      return dir === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
    }
    if (key === 'size') {
      return dir === 'asc' ? a.size - b.size : b.size - a.size;
    }
    if (key === 'modified') {
      const am = parseToMs(a.modified) ?? 0;
      const bm = parseToMs(b.modified) ?? 0;
      return dir === 'asc' ? am - bm : bm - am;
    }

    // Handle sorting by custom fields
    const aValue = a.custom[key];
    const bValue = b.custom[key];

    // If both files have the field
    if (aValue !== undefined && bValue !== undefined) {
      // Compare based on data type
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return dir === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      } else if (typeof aValue === 'number' && typeof bValue === 'number') {
        return dir === 'asc' ? aValue - bValue : bValue - aValue;
      } else if (aValue === null && bValue !== null) {
        return dir === 'asc' ? -1 : 1;
      } else if (aValue !== null && bValue === null) {
        return dir === 'asc' ? 1 : -1;
      }
    }

    // If only one file has the field, sort that one first or last depending on direction
    if (aValue !== undefined && bValue === undefined) {
      return dir === 'asc' ? -1 : 1;
    }
    if (aValue === undefined && bValue !== undefined) {
      return dir === 'asc' ? 1 : -1;
    }

    return 0;
  });
  return sorted;
}

/**
 * Props for the FileTable component.
 */
interface FileTableProps {
  /** Unique ID for the droppable area (used in drag-and-drop) */
  droppableId: string;
  /** Array of file entries to display in the table */
  files: FileEntry[];
  /** Current sort column key */
  sortKey: SortKey;
  /** Current sort direction */
  sortDir: SortDir;
  /** Callback fired when a column header is clicked to change sort */
  onSort: (key: SortKey) => void;
  /** Callback fired when a file is selected (single click) */
  onFileSelect?: (file: FileEntry) => void;
  /** Callback fired when a folder is opened (double click or Enter) */
  onFolderOpen?: (folder: FileEntry) => void;
  /** ID of the folder currently being hovered during drag combine */
  combineTargetId?: string | null;
  /** Whether to show computed folder sizes */
  showFolderSizesEnabled?: boolean;
  /** Whether a drag operation is currently in progress */
  isDragging?: boolean;
  /** ID of the item currently being dragged */
  draggingItemId?: string | null;
  /** Callback fired when a drag operation begins */
  onBeginDrag?: (file: FileEntry) => void;
  /** Callback fired when hovering over a folder during drag */
  onHoverFolder?: (file: FileEntry | null) => void;
  /** Callback fired when hovering over the table container during drag */
  onHoverContainer?: (path: string) => void;
  /** Ref to register the getSelectedFiles function for keyboard clipboard shortcuts */
  getSelectedFilesRef?: React.MutableRefObject<GetSelectedFilesFunction | null>;
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

type TableSelectionEvent =
  | React.MouseEvent<HTMLTableRowElement>
  | React.KeyboardEvent<HTMLTableRowElement>;

// Helper to determine if entry is a directory
function isDirectory(file: FileEntry): boolean {
  return !!file.is_dir;
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

// Helper to determine the appropriate tag style based on field name and value
function getTagStyle(fieldName: string, value: unknown): string {
  // Status field styling
  if (fieldName.toLowerCase() === 'status') {
    switch (String(value).toLowerCase()) {
      case 'done':
      case 'completed':
        return styles.tagDone;
      case 'in progress':
      case 'wip':
      case 'ongoing':
        return styles.tagInProgress;
      case 'todo':
      case 'pending':
      case 'planned':
        return styles.tagTodo;
      default:
        return styles.tagGray;
    }
  }

  // Priority field styling
  if (fieldName.toLowerCase() === 'priority') {
    switch (String(value).toLowerCase()) {
      case 'high':
      case 'urgent':
        return styles.tagRed;
      case 'medium':
        return styles.tagYellow;
      case 'low':
        return styles.tagGreen;
      default:
        return styles.tagGray;
    }
  }

  // Tag field special handling - cycle through colors
  if (fieldName.toLowerCase() === 'tags' || fieldName.toLowerCase() === 'tag') {
    const tagColors = [styles.tagBlue, styles.tagGreen, styles.tagPurple, styles.tagYellow];
    // Simple hash of string to get consistent color for same tag
    const hash = String(value)
      .split('')
      .reduce((a, b) => {
        return a + b.charCodeAt(0);
      }, 0);
    return tagColors[hash % tagColors.length];
  }

  // Default tag styling based on field name
  switch (fieldName.toLowerCase()) {
    case 'type':
      return styles.tagBlue;
    case 'category':
      return styles.tagPurple;
    case 'project':
      return styles.tagGreen;
    default:
      return styles.tagGray;
  }
}

function FileTableInner({
  droppableId,
  files,
  sortKey,
  sortDir,
  onSort,
  onFileSelect,
  onFolderOpen,
  combineTargetId,
  showFolderSizesEnabled,
  isDragging,
  draggingItemId,
  onBeginDrag,
  onHoverFolder,
  onHoverContainer,
  getSelectedFilesRef,
}: FileTableProps) {
  const { show: showToast } = useToast();
  const tableId = useId();

  // Defensive: ensure files is an array
  const safeFiles = useMemo<FileEntry[]>(() => {
    if (Array.isArray(files)) return files;
    try {
      console.warn("FileTable: 'files' prop is not an array. Rendering empty table.", files);
    } catch {}
    return [];
  }, [files]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);

  // Track selection count for announcements
  const prevSelectionCount = useRef(0);

  // Helper: container path extracted from droppableId like "list:/foo" | "column:/foo"
  const containerPath = useMemo(() => {
    const m = droppableId.match(/^(?:column|list|grid):(.+)$/);
    return m ? m[1] : '';
  }, [droppableId]);

  // Custom columns derived via helper (bounded scan size)
  const customColumns = useMemo(() => getCustomColumns(safeFiles), [safeFiles]);

  // Note: row selection logic handled by the handler below

  // Extract tags from custom fields
  const getFileTags = (file: FileEntry) => {
    const tags: { key: string; value: string; style: string }[] = [];

    if (!file.custom) return tags;

    // Process explicit tag arrays
    const tagsField = file.custom.tags;
    if (Array.isArray(tagsField)) {
      tagsField.forEach((tag) => {
        tags.push({
          key: `tag-${tag}`,
          value: String(tag),
          style: getTagStyle('tags', tag),
        });
      });
    }

    // Process other custom fields that might be good as tags
    Object.entries(file.custom).forEach(([key, value]) => {
      // Skip tag arrays we already processed
      if (key === 'tags' && Array.isArray(value)) return;

      // Skip fields that are being displayed as columns
      if (customColumns.includes(key)) return;

      // Don't display empty/null values
      if (value === null || value === undefined || value === '') return;

      // Skip complex objects
      if (typeof value === 'object' && !Array.isArray(value)) return;

      // For arrays, add each item as a separate tag
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          tags.push({
            key: `${key}-${i}`,
            value: String(item),
            style: getTagStyle(key, item),
          });
        });
      } else {
        // For simple values, add as a single tag
        tags.push({
          key: key,
          value: String(value),
          style: getTagStyle(key, value),
        });
      }
    });

    return tags;
  };

  const [sortedFiles, setSortedFiles] = useState<FileEntry[]>(safeFiles);
  const [isSorting, setIsSorting] = useState(false);
  const SORT_WORKER_THRESHOLD = 5000;

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

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; files: FileEntry[] }>({
    open: false,
    files: [],
  });
  const confirmBeforeDelete = useFileStore((s) => s.confirmBeforeDelete);
  const setConfirmBeforeDelete = useFileStore((s) => s.setConfirmBeforeDelete);

  React.useEffect(() => {
    let cancelled = false;
    const count = safeFiles.length;
    if (count === 0) {
      setSortedFiles([]);
      setIsSorting(false);
      return;
    }
    if (count >= SORT_WORKER_THRESHOLD) {
      try {
        setIsSorting(true);
        const worker = new Worker(new URL('../workers/sortWorker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (ev: MessageEvent<FileEntry[]>) => {
          if (cancelled) return;
          setSortedFiles(ev.data);
          setIsSorting(false);
          worker.terminate();
        };
        worker.onerror = () => {
          if (!cancelled) {
            setSortedFiles(sortFiles(safeFiles, sortKey, sortDir));
            setIsSorting(false);
          }
          worker.terminate();
        };
        worker.postMessage({ files: safeFiles, key: String(sortKey), dir: sortDir });
        return () => {
          cancelled = true;
          try {
            worker.terminate();
          } catch {}
        };
      } catch {
        setSortedFiles(sortFiles(safeFiles, sortKey, sortDir));
        setIsSorting(false);
      }
    } else {
      setSortedFiles(sortFiles(safeFiles, sortKey, sortDir));
      setIsSorting(false);
    }
    return () => {
      cancelled = true;
    };
  }, [safeFiles, sortKey, sortDir]);

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

  const listRowHeight = useFileStore((s) => s.listRowHeight);
  const uiScale = useFileStore((s) => s.uiScale);
  const rowHeight = React.useMemo(
    () => Math.round(listRowHeight * uiScale),
    [listRowHeight, uiScale]
  );

  // Virtualization: bind to scroll container and compute visible row range
  const containerRef = useRef<HTMLDivElement>(null);
  const { totalSize, virtualRows } = useVirtualRows({
    count: sortedFiles.length,
    parentRef: containerRef as React.RefObject<HTMLElement>,
    estimateSize: rowHeight,
    overscan: 3,
    freeze: !!isDragging,
  });
  const dragStart = useDragStart({ onBeginDrag, isEnabled: !!onBeginDrag });

  // Marquee selection uses current list row height
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [headerHeight, setHeaderHeight] = React.useState(0);

  // Measure header height (tracks font/UI scale changes)
  React.useLayoutEffect(() => {
    const thead = theadRef.current;
    if (!thead) return;
    const update = () => setHeaderHeight(thead.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(thead);
    return () => observer.disconnect();
  }, []);

  const getItemRect = useCallback(
    (index: number) => {
      if (index < 0 || index >= sortedFiles.length) return null;
      const top = index * rowHeight;
      return {
        left: 0,
        top,
        right: containerRef.current?.clientWidth ?? 1000,
        bottom: top + rowHeight,
      };
    },
    [sortedFiles.length, rowHeight]
  );

  const getItemId = useCallback(
    (index: number) => {
      return sortedFiles[index]?.id ?? '';
    },
    [sortedFiles]
  );

  const handleMarqueeSelectionChange = useCallback(
    (ids: Set<string>, additive: boolean) => {
      if (additive) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.add(id));
          // Announce selection change
          if (next.size !== prevSelectionCount.current) {
            announceSelection(next.size, sortedFiles.length);
            prevSelectionCount.current = next.size;
          }
          return next;
        });
      } else {
        setSelectedIds(ids);
        // Announce selection change
        if (ids.size !== prevSelectionCount.current) {
          announceSelection(ids.size, sortedFiles.length);
          prevSelectionCount.current = ids.size;
        }
      }
    },
    [sortedFiles.length]
  );

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
    itemSelector: `tr.${styles.clickable}`,
    contentOffsetTop: headerHeight,
    onEmptyClick: handleEmptyClick,
  });

  const editingId = useFileStore((s) => s.editingId);
  const setEditingId = useFileStore((s) => s.setEditingId);
  const setDraftNew = useFileStore((s) => s.setDraftNew);
  const setFiles = useFileStore((s) => s.setFiles);
  const clipboard = useFileStore((s) => s.clipboard);
  const pendingSelectPathRef = useRef<string | null>(null);

  // Select and scroll to an item after list refresh
  React.useEffect(() => {
    const target = pendingSelectPathRef.current;
    if (!target) return;
    const idx = sortedFiles.findIndex((f) => f.path === target);
    if (idx >= 0) {
      setSelectedIds(new Set([sortedFiles[idx].id]));
      setAnchorIndex(idx);
      setCursorIndex(idx);
      const el = containerRef.current;
      if (el) {
        const top = Math.max(0, idx * rowHeight - rowHeight);
        el.scrollTo({ top, behavior: 'smooth' });
      }
      pendingSelectPathRef.current = null;
    }
  }, [sortedFiles, rowHeight]);

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

  // Note: using native table layout for consistent spacing and alignment

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

          await renamePath(oldPath, newName);
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
                  await renamePath(newPath, oldName);
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
                  await renamePath(oldPath, newName);
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
          path: containerPath,
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
    [containerPath, setFiles, showToast]
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
      path: containerPath,
      calc_dir_size: false,
    });
    setFiles(withDisplayNames(res));
    setArchiveDialog({ open: false, mode: 'compress', files: [] });
  }, [containerPath, setFiles]);

  // Delete handlers
  const performDelete = useCallback(
    async (files: FileEntry[], permanent: boolean = false) => {
      try {
        const refresh = async () => {
          const res = await invoke<FileEntry[]>('list_files', {
            path: containerPath,
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
    [containerPath, setFiles, showToast]
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

  const handleRowClick = useCallback(
    (e: TableSelectionEvent, index: number, file: FileEntry) => {
      const isRange = e.shiftKey;
      const isToggle = e.ctrlKey || e.metaKey;
      const next = new Set(selectedIds);
      if (isRange) {
        const anchor = anchorIndex ?? index;
        const start = Math.min(anchor, index);
        const end = Math.max(anchor, index);
        next.clear();
        for (let i = start; i <= end; i++) {
          next.add(sortedFiles[i].id);
        }
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
    [anchorIndex, onFileSelect, selectedIds, sortedFiles]
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
        // Start inline rename on first selected item
        const firstId = Array.from(selectedIds)[0];
        if (firstId) {
          e.preventDefault();
          setEditingId(firstId);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const current =
          cursorIndex ??
          (selectedIds.size ? sortedFiles.findIndex((f) => selectedIds.has(f.id)) : -1);
        const start = Math.max(
          0,
          current < 0 ? (dir > 0 ? 0 : sortedFiles.length - 1) : current + dir
        );
        const nextIdx = Math.min(sortedFiles.length - 1, Math.max(0, start));
        const nextId = sortedFiles[nextIdx]?.id;
        if (nextId == null) return;
        if (e.shiftKey) {
          const anchor = anchorIndex ?? cursorIndex ?? nextIdx;
          const a = Math.min(anchor, nextIdx);
          const b = Math.max(anchor, nextIdx);
          const range = new Set<string>();
          for (let i = a; i <= b; i++) range.add(sortedFiles[i].id);
          setSelectedIds(range);
          // keep anchor; move cursor
          setCursorIndex(nextIdx);
        } else {
          setSelectedIds(new Set([nextId]));
          setAnchorIndex(nextIdx);
          setCursorIndex(nextIdx);
        }
      }
    },
    [anchorIndex, cursorIndex, selectedIds, setEditingId, sortedFiles]
  );

  // Context menu state
  const contextMenu = useContextMenu();

  return (
    <div
      className={styles.tableContainer}
      ref={(el) => {
        containerRef.current = el as HTMLDivElement;
      }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        // Only open container menu if there's something to show (e.g., Paste)
        if (clipboard) contextMenu.openForEmpty(e, containerPath);
      }}
      onMouseEnter={() => {
        if (isDragging) {
          const m = droppableId.match(/^(column|list|grid):(.+)$/);
          const path = m ? m[2] : '';
          onHoverContainer?.(path);
        }
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        // If clicking on a real data row, do nothing (row handles selection)
        const tr = target.closest('tr') as HTMLElement | null;
        if (tr && tr.classList && tr.classList.contains(styles.clickable)) return;
        // Ignore header clicks
        if (target.closest('thead')) return;
        // Start marquee selection (it handles clearing selection internally)
        marquee.onMouseDown(e);
        setAnchorIndex(null);
        setCursorIndex(null);
      }}
    >
      {/* Marquee selection overlay */}
      {marquee.isActive && marquee.rect && (
        <div
          className={styles.marquee}
          style={{
            position: 'absolute',
            left: marquee.rect.left,
            top: marquee.rect.top,
            width: marquee.rect.width,
            height: marquee.rect.height,
            pointerEvents: 'none',
          }}
        />
      )}
      <table
        className={styles.fileTable}
        role="grid"
        aria-label={`Files in current folder, ${sortedFiles.length} items`}
        aria-rowcount={sortedFiles.length + 1}
        aria-colcount={4 + customColumns.length}
        aria-multiselectable="true"
        id={tableId}
      >
        <thead ref={theadRef}>
          <tr role="row" aria-rowindex={1}>
            <th
              className={styles.sortable}
              onClick={() => onSort('name')}
              role="columnheader"
              scope="col"
              {...getSortableColumnProps('name', sortKey, sortDir)}
            >
              Name
              {sortKey === 'name' && (
                <span className={styles.sortIcon} aria-hidden="true">
                  <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} />
                </span>
              )}
              {sortKey === 'name' && isSorting && (
                <span className={styles.sortSpinner} aria-label="sorting" />
              )}
            </th>
            {customColumns.map((column) => (
              <th
                key={column}
                className={styles.sortable}
                onClick={() => onSort(column)}
                role="columnheader"
                scope="col"
                {...getSortableColumnProps(column, sortKey, sortDir)}
              >
                {column.charAt(0).toUpperCase() + column.slice(1)}
                {sortKey === column && (
                  <span className={styles.sortIcon} aria-hidden="true">
                    <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} />
                  </span>
                )}
                {sortKey === column && isSorting && (
                  <span className={styles.sortSpinner} aria-label="sorting" />
                )}
              </th>
            ))}
            <th
              className={`${styles.sortable} ${styles.fileSize}`}
              onClick={() => onSort('size')}
              title={
                showFolderSizesEnabled
                  ? 'Folder sizes compute on demand and may take time'
                  : 'Enable Folder Sizes in settings to compute directory sizes'
              }
              role="columnheader"
              scope="col"
              {...getSortableColumnProps('size', sortKey, sortDir)}
            >
              Size
              {sortKey === 'size' && (
                <span className={styles.sortIcon} aria-hidden="true">
                  <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} />
                </span>
              )}
              {sortKey === 'size' && isSorting && (
                <span className={styles.sortSpinner} aria-label="sorting" />
              )}
            </th>
            <th
              className={`${styles.sortable} ${styles.fileModified}`}
              onClick={() => onSort('modified')}
              role="columnheader"
              scope="col"
              {...getSortableColumnProps('modified', sortKey, sortDir)}
            >
              Modified
              {sortKey === 'modified' && (
                <span className={styles.sortIcon} aria-hidden="true">
                  <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} />
                </span>
              )}
              {sortKey === 'modified' && isSorting && (
                <span className={styles.sortSpinner} aria-label="sorting" />
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {virtualRows.length > 0 && <tr style={{ height: `${virtualRows[0].start}px` }} />}
          {virtualRows.map((vr) => {
            const index = vr.index;
            const file = sortedFiles[index];
            const fileTags = getFileTags(file);
            const isSource = isDragging && draggingItemId === file.id;
            const isSelected = selectedIds.has(file.id);
            const fileName = file.name ?? (file.path.split(/[/\\]/).pop() || file.path);
            return (
              <tr
                key={file.id}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={isSelected}
                aria-label={`${isDirectory(file) ? 'Folder' : 'File'}: ${fileName}${isSelected ? ', selected' : ''}`}
                className={`${styles.clickable} ${isSelected ? styles.selected : ''} ${isSource ? styles.dragSource : ''} ${combineTargetId === file.id && isDirectory(file) ? styles.dropTargetRow : ''}`}
                onClick={(e) => handleRowClick(e, index, file)}
                onContextMenu={(e) => {
                  contextMenu.openForFile(e, file, containerPath);
                  setSelectedIds(new Set([file.id]));
                  setAnchorIndex(index);
                  setCursorIndex(index);
                }}
                onDoubleClick={() => {
                  if (isDirectory(file)) onFolderOpen?.(file);
                  else
                    invoke('open_path', { path: file.path }).catch((err) =>
                      console.error('open_path failed', err)
                    );
                }}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (isDirectory(file)) onFolderOpen?.(file);
                    else
                      invoke('open_path', { path: file.path }).catch((err) =>
                        console.error('open_path failed', err)
                      );
                  } else if (e.key === ' ') {
                    handleRowClick(e, index, file);
                  }
                }}
                onMouseDown={(e) => dragStart.onMouseDown(e, file)}
                onMouseEnter={() => {
                  if (isDragging) {
                    if (isDirectory(file) && !isSource) onHoverFolder?.(file);
                    else onHoverFolder?.(null);
                  }
                }}
                style={isSource ? { pointerEvents: 'none' } : undefined}
              >
                <td className={styles.fileNameCell} role="gridcell">
                  <span className={styles.fileIcon} aria-hidden="true">
                    <Icon name={getFileIconName(file)} />
                  </span>
                  {editingId === file.id ? (
                    <InlineRename
                      key={`edit:${file.id}`}
                      file={file}
                      onDone={async (committed: boolean, newName?: string) => {
                        try {
                          if (!committed) {
                            // Cancel: drop draft or stop editing
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
                            // Create on disk
                            const createdPath = await createFolderIn(containerPath, name);
                            setDraftNew(null);
                            pendingSelectPathRef.current = createdPath;
                          } else {
                            const newPath = await renamePath(file.path, name);
                            pendingSelectPathRef.current = newPath;
                          }
                          // Refresh current container files
                          try {
                            const res = await invoke<FileEntry[]>('list_files', {
                              path: containerPath,
                              calc_dir_size: false,
                            });
                            setFiles(withDisplayNames(res));
                          } catch {}
                        } finally {
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <span className={styles.fileName}>{fileName}</span>
                  )}
                  {fileTags.map((tag) => (
                    <span
                      key={tag.key}
                      className={`${styles.tag} ${tag.style}`}
                      aria-label={`Tag: ${tag.value}`}
                    >
                      {tag.value}
                    </span>
                  ))}
                </td>
                {customColumns.map((column) => (
                  <td key={column} className={styles.customColumn} role="gridcell">
                    {file.custom && file.custom[column] !== undefined
                      ? String(file.custom[column])
                      : '-'}
                  </td>
                ))}
                <td className={styles.fileSize} role="gridcell">
                  {isDirectory(file)
                    ? file.size === 0
                      ? showFolderSizesEnabled
                        ? '…'
                        : '-'
                      : formatBytes(file.size)
                    : formatBytes(file.size)}
                </td>
                <td className={styles.fileModified} role="gridcell">
                  {formatLocalDate(file.modified)}
                </td>
              </tr>
            );
          })}
          {virtualRows.length > 0 && (
            <tr
              style={{
                height: `${Math.max(0, totalSize - (virtualRows[virtualRows.length - 1].start + virtualRows[virtualRows.length - 1].size))}px`,
              }}
            />
          )}
        </tbody>
      </table>
      {/* no placeholder in virtual mode */}
      <ContextMenu
        state={contextMenu.state}
        onClose={contextMenu.close}
        onRename={(file) => setEditingId(file.id)}
        onBatchRename={handleBatchRename}
        onRefresh={async () => {
          const res = await invoke<FileEntry[]>('list_files', {
            path: containerPath,
            calc_dir_size: false,
          });
          setFiles(withDisplayNames(res));
        }}
        onCompress={handleCompress}
        onExtract={handleExtract}
        confirmBeforeDelete={confirmBeforeDelete}
        onDeleteConfirm={(files) => setDeleteConfirm({ open: true, files })}
      />
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
            currentPath={containerPath}
            onClose={handleArchiveClose}
            onSuccess={handleArchiveSuccess}
          />
        </React.Suspense>
      )}
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
    </div>
  );
}

/**
 * FileTable is the core table component used by ListView for rendering files.
 *
 * Features:
 * - Sortable column headers with visual indicators
 * - Virtual scrolling for performance with large directories
 * - Multi-select with Shift/Ctrl modifiers and marquee selection
 * - Inline rename editing
 * - Drag-and-drop support with visual feedback
 * - Context menu integration for file operations
 * - Keyboard navigation (arrow keys, Enter, Delete, F2)
 * - Custom field columns from .explorie.json metadata
 * - ARIA accessibility attributes for screen readers
 *
 * @example
 * ```tsx
 * <FileTable
 *   droppableId={currentPath}
 *   files={entries}
 *   sortKey="name"
 *   sortDir="asc"
 *   onSort={(key) => handleSort(key)}
 *   onFileSelect={(file) => preview(file)}
 *   onFolderOpen={(folder) => navigate(folder.path)}
 * />
 * ```
 */
export const FileTable = React.memo(FileTableInner);

function InlineRename({
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
      style={{ minWidth: 120 }}
      aria-label="Rename file"
      aria-describedby="rename-instructions"
    />
  );
}
