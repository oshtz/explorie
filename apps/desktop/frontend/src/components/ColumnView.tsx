import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import styles from './ColumnView.module.css';
import { Icon } from './Icon';
import type { IconName } from '../icons';
import { invoke } from '@tauri-apps/api/core';
import type { SortKey, SortDir } from './FileTable';
import { sortFiles } from './FileTable';
import { createFolderIn, joinPaths, renamePath } from '../utils/fs';
import { useDragStart } from '../hooks/useDragStart';
import type { DragStartHandler } from '../hooks/useDragStart';
import { useMarqueeSelection } from '../hooks/useMarqueeSelection';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { useToast } from './Toast';
import { deleteWithUndo } from '../utils/fileOperations';
import { reportError } from '../utils/errorReporter';
import type { GetSelectedFilesFunction } from '../hooks/useKeyboardClipboard';
import { useVirtualRows } from '../hooks/useVirtualRows';

// Column width constants
const MIN_COLUMN_WIDTH = 180;
const MAX_COLUMN_WIDTH = 600;
const DEFAULT_COLUMN_WIDTH = 260;

// Local storage key for column widths
const COLUMN_WIDTHS_STORAGE_KEY = 'explorie:columnWidths';

/**
 * Load column widths from local storage.
 * Returns a Record where keys are column indices (as strings) and values are widths.
 */
function loadColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Save column widths to local storage.
 */
function saveColumnWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Custom hook for managing column widths with persistence.
 */
function useColumnWidths() {
  const [widths, setWidths] = useState<Record<string, number>>(() => loadColumnWidths());

  // Persist widths to local storage whenever they change
  useEffect(() => {
    saveColumnWidths(widths);
  }, [widths]);

  const getColumnWidth = useCallback(
    (colIdx: number): number => {
      const key = String(colIdx);
      return widths[key] ?? DEFAULT_COLUMN_WIDTH;
    },
    [widths]
  );

  const setColumnWidth = useCallback((colIdx: number, width: number) => {
    const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
    setWidths((prev) => ({
      ...prev,
      [String(colIdx)]: clamped,
    }));
  }, []);

  return { getColumnWidth, setColumnWidth };
}

/**
 * Column resize handle component.
 */
interface ColumnResizeHandleProps {
  colIdx: number;
  currentWidth: number;
  onResize: (colIdx: number, width: number) => void;
}

function ColumnResizeHandle({ colIdx, currentWidth, onResize }: ColumnResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = currentWidth;
      setIsResizing(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const newWidth = startWidth + deltaX;
        onResize(colIdx, newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        document.body.classList.remove(styles.columnResizing);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      document.body.classList.add(styles.columnResizing);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [colIdx, currentWidth, onResize]
  );

  // Double-click to reset to default width
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onResize(colIdx, DEFAULT_COLUMN_WIDTH);
    },
    [colIdx, onResize]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      let nextWidth: number | null = null;
      if (event.key === 'ArrowLeft') nextWidth = currentWidth - 10;
      if (event.key === 'ArrowRight') nextWidth = currentWidth + 10;
      if (event.key === 'Home') nextWidth = MIN_COLUMN_WIDTH;
      if (event.key === 'End') nextWidth = MAX_COLUMN_WIDTH;
      if (nextWidth === null) return;
      event.preventDefault();
      event.stopPropagation();
      onResize(colIdx, nextWidth);
    },
    [colIdx, currentWidth, onResize]
  );

  return (
    <div
      ref={handleRef}
      className={`${styles.columnResizeHandle} ${isResizing ? styles.columnResizeHandleActive : ''}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize column ${colIdx + 1}`}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={currentWidth}
      tabIndex={0}
      title="Drag to resize column (double-click to reset)"
    />
  );
}

const LazySecureDeleteDialog = React.lazy(() =>
  import('./SecureDeleteDialog').then((m) => ({ default: m.SecureDeleteDialog }))
);

const LazyArchiveDialog = React.lazy(() =>
  import('./ArchiveDialog').then((m) => ({ default: m.ArchiveDialog }))
);

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
      return 'file-text';
    case 'doc':
    case 'docx':
      return 'file-text';
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
      return 'file-text';
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
      return 'file-text';
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

const columnRowHeight = (uiScale: number) => Math.round(32 * uiScale) + 2;

type ColumnSelection = { ids: Set<string>; anchor: number | null };
type ColumnSelectionByPath = Record<string, ColumnSelection>;

interface ColumnFileListProps {
  path: string;
  colIdx: number;
  visible: FileEntry[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>, anchor: number | null) => void;
  onItemClick: (e: React.MouseEvent | React.KeyboardEvent, index: number, file: FileEntry) => void;
  onFolderClick: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, file: FileEntry) => void;
  onHoverContainerPath?: (path: string) => void;
  onHoverFolder?: (file: FileEntry | null) => void;
  dragCombineTargetId?: string | null;
  draggingItemIds?: ReadonlySet<string>;
  dragStart: { onMouseDown: (e: React.MouseEvent, file: FileEntry) => void };
  editingId: string | null;
  renderEditingItem: (entry: FileEntry, path: string) => React.ReactNode;
  listRef?: React.Ref<HTMLUListElement>;
  rowHeight: number;
}

function ColumnFileList({
  path,
  visible,
  selectedIds,
  onSelectionChange,
  onItemClick,
  onFolderClick,
  onContextMenu,
  onHoverContainerPath,
  onHoverFolder,
  dragCombineTargetId,
  draggingItemIds,
  dragStart,
  editingId,
  renderEditingItem,
  listRef: externalRef,
  rowHeight,
}: ColumnFileListProps) {
  const internalRef = React.useRef<HTMLUListElement>(null);
  const listRef = (externalRef as React.RefObject<HTMLUListElement>) || internalRef;

  const getItemRect = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= visible.length) return null;
      const top = index * rowHeight;
      return {
        left: 0,
        top,
        right: listRef.current?.clientWidth ?? 200,
        bottom: top + rowHeight,
      };
    },
    [visible.length, listRef, rowHeight]
  );

  const getItemId = React.useCallback(
    (index: number) => {
      return visible[index]?.id ?? '';
    },
    [visible]
  );

  const handleMarqueeSelectionChange = React.useCallback(
    (ids: Set<string>, additive: boolean) => {
      if (additive) {
        const next = new Set(selectedIds);
        ids.forEach((id) => next.add(id));
        onSelectionChange(next, null);
      } else {
        onSelectionChange(ids, null);
      }
    },
    [selectedIds, onSelectionChange]
  );

  const handleEmptyClick = React.useCallback(() => {
    onSelectionChange(new Set(), null);
  }, [onSelectionChange]);

  const marquee = useMarqueeSelection({
    containerRef: listRef as React.RefObject<HTMLElement>,
    getItemRect,
    itemCount: visible.length,
    getItemId,
    onSelectionChange: handleMarqueeSelectionChange,
    enabled: !draggingItemIds?.size,
    itemSelector: 'li[data-file-id]',
    onEmptyClick: handleEmptyClick,
  });
  const focusId = selectedIds.values().next().value;
  const { totalSize, virtualRows } = useVirtualRows({
    count: visible.length,
    parentRef: listRef as React.RefObject<HTMLElement>,
    estimateSize: rowHeight,
    overscan: 4,
    freeze: !!draggingItemIds?.size,
  });
  const topSpacer = virtualRows[0]?.start ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1];
  const bottomSpacer = lastRow ? Math.max(0, totalSize - lastRow.start - lastRow.size) : 0;
  const spacerStyle = (height: number): React.CSSProperties => ({
    height,
    minHeight: height,
    margin: 0,
    padding: 0,
    pointerEvents: 'none',
  });

  return (
    <ul
      ref={listRef}
      className={styles.fileList}
      role="listbox"
      aria-label={`Files in ${path}`}
      aria-multiselectable="true"
      onMouseEnter={() => onHoverContainerPath?.(path)}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest('li[data-file-id]')) return;
        marquee.onMouseDown(e);
        onHoverFolder?.(null);
      }}
    >
      {/* Marquee overlay */}
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
      {visible.length === 0 && (
        <li className={styles.emptyColumn} role="presentation">
          This folder is empty
        </li>
      )}
      {topSpacer > 0 && <li aria-hidden="true" style={spacerStyle(topSpacer)} />}
      {virtualRows.map((row) => {
        const index = row.index;
        const entry = visible[index];
        if (!entry) return null;
        const isFolder = isDirectory(entry);
        const fileName = entry.path.split(/[/\\]/).pop() || entry.path;
        const isSource = draggingItemIds?.has(entry.id) ?? false;

        return (
          <li
            key={entry.id}
            data-file-id={entry.id}
            className={`${styles.fileItem} ${isFolder ? styles.folder : styles.file} ${selectedIds.has(entry.id) ? styles.selected : ''} ${isSource ? styles.dragSource : ''} ${dragCombineTargetId === entry.id && isFolder ? styles.dropTarget : ''}`}
            role="option"
            aria-selected={selectedIds.has(entry.id)}
            aria-setsize={visible.length}
            aria-posinset={index + 1}
            tabIndex={focusId === entry.id ? 0 : -1}
            aria-label={isFolder ? `Open folder ${fileName}` : `Select file ${fileName}`}
            onClick={(e) => onItemClick(e, index, entry)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            onDoubleClick={() => {
              if (isFolder) onFolderClick(entry);
              else
                invoke('open_path', { path: entry.path }).catch((err) =>
                  console.error('open_path failed', err)
                );
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (isFolder) onFolderClick(entry);
                else
                  invoke('open_path', { path: entry.path }).catch((err) =>
                    console.error('open_path failed', err)
                  );
              } else if (e.key === ' ') {
                onItemClick(e, index, entry);
              }
            }}
            onMouseDown={(e) => dragStart.onMouseDown(e, entry)}
            onMouseEnter={() => {
              if (draggingItemIds?.size && isFolder && !isSource) onHoverFolder?.(entry);
              else if (draggingItemIds?.size) onHoverFolder?.(null);
            }}
            style={{
              height: rowHeight - 2,
              minHeight: rowHeight - 2,
              ...(isSource ? { pointerEvents: 'none' } : {}),
            }}
          >
            <span className={styles.fileIcon}>
              <Icon name={getFileIconName(entry)} />
            </span>
            {editingId === entry.id ? (
              renderEditingItem(entry, path)
            ) : (
              <span className={styles.fileName} title={fileName}>
                {fileName}
              </span>
            )}
            <span className={styles.fileSize}>
              {entry.is_dir && entry.size === 0 ? '-' : formatBytes(entry.size)}
            </span>
          </li>
        );
      })}
      {bottomSpacer > 0 && <li aria-hidden="true" style={spacerStyle(bottomSpacer)} />}
    </ul>
  );
}

/**
 * Props for the ColumnView component.
 */
interface ColumnViewProps {
  /** Stack of directory paths representing each column (left to right) */
  pathStack: string[];
  /** Map of directory path to file entries for each column */
  columnFiles: { [path: string]: FileEntry[] };
  /** Callback fired when a folder is clicked in a column */
  onFolderClick: (colIdx: number, entry: FileEntry) => void;
  /** Callback fired when navigating back in a column */
  onColumnBack: (colIdx: number) => void;
  /** Callback fired when a file is selected */
  onFileSelect?: (file: FileEntry | null) => void;
  /** ID of the folder currently being hovered during drag combine */
  dragCombineTargetId?: string | null;
  /** IDs of the items currently being dragged */
  draggingItemIds?: ReadonlySet<string>;
  /** Callback fired when a drag operation begins */
  onBeginDrag?: DragStartHandler;
  /** Callback fired when hovering over a column container during drag */
  onHoverContainerPath?: (path: string) => void;
  /** Callback fired when hovering over a folder during drag */
  onHoverFolder?: (file: FileEntry | null) => void;
  /** Width of the preview panel (affects scrolling) */
  previewWidth?: number;
  /** Whether the preview panel is visible */
  previewVisible?: boolean;
  /** Ref to register the getSelectedFiles function for keyboard clipboard shortcuts */
  getSelectedFilesRef?: React.MutableRefObject<GetSelectedFilesFunction | null>;
}

function ColumnViewInner({
  pathStack,
  columnFiles,
  onFolderClick,
  onColumnBack,
  onFileSelect,
  dragCombineTargetId,
  draggingItemIds,
  onBeginDrag,
  onHoverContainerPath,
  onHoverFolder,
  previewWidth,
  previewVisible,
  getSelectedFilesRef,
}: ColumnViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const contextMenu = useContextMenu();
  const clipboard = useFileStore((s) => s.clipboard);
  const dragStart = useDragStart({ onBeginDrag, isEnabled: !!onBeginDrag });
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const selectionCursorPath = useFileStore((s) => s.selectionCursorPath);
  const setSelectedPaths = useFileStore((s) => s.setSelectedPaths);
  const setSelectionCursorPath = useFileStore((s) => s.setSelectionCursorPath);
  const [anchorsByPath, setAnchorsByPath] = useState<Record<string, number | null>>({});
  const {
    showHidden,
    sortKey,
    sortDir,
    filterMode,
    searchQuery,
    draftNew,
    editingId,
    pathStack: pathStackState,
    confirmBeforeDelete,
    uiScale,
  } = useFileStore();
  const rowHeight = columnRowHeight(uiScale ?? 1);
  const setEditingId = useFileStore((s) => s.setEditingId);
  const setDraftNew = useFileStore((s) => s.setDraftNew);
  const setPathStackStore = useFileStore((s) => s.setPathStack);
  const setConfirmBeforeDelete = useFileStore((s) => s.setConfirmBeforeDelete);
  const { show: showToast } = useToast();

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; files: FileEntry[] }>({
    open: false,
    files: [],
  });

  // Archive dialog state
  const [archiveDialog, setArchiveDialog] = useState<{
    open: boolean;
    mode: 'compress' | 'extract';
    files: FileEntry[];
    currentPath: string;
  }>({ open: false, mode: 'compress', files: [], currentPath: '' });

  // Column width management with persistence
  const { getColumnWidth, setColumnWidth } = useColumnWidths();

  // Defensive: ensure we always operate on arrays
  const getSafeFiles = React.useCallback(
    (path: string): FileEntry[] => {
      const list = columnFiles?.[path];
      if (Array.isArray(list)) return list;
      try {
        console.warn("ColumnView: 'columnFiles[path]' is not an array. Using empty list.", {
          path,
          value: list,
        });
      } catch {}
      return [];
    },
    [columnFiles]
  );

  const selectedPathSet = React.useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectionByPath = React.useMemo<ColumnSelectionByPath>(() => {
    const next: ColumnSelectionByPath = {};
    for (const path of Object.keys(columnFiles || {})) {
      next[path] = {
        ids: new Set(
          getSafeFiles(path)
            .filter((file) => selectedPathSet.has(file.path))
            .map((file) => file.id)
        ),
        anchor: anchorsByPath[path] ?? null,
      };
    }
    return next;
  }, [anchorsByPath, columnFiles, getSafeFiles, selectedPathSet]);

  const setSelectionByPath = useCallback(
    (updater: React.SetStateAction<ColumnSelectionByPath>) => {
      const next = typeof updater === 'function' ? updater(selectionByPath) : updater;
      const paths: string[] = [];
      const anchors: Record<string, number | null> = {};
      for (const [path, selection] of Object.entries(next)) {
        anchors[path] = selection.anchor;
        for (const file of getSafeFiles(path)) {
          if (selection.ids.has(file.id)) paths.push(file.path);
        }
      }
      setAnchorsByPath(anchors);
      setSelectedPaths(paths);
    },
    [getSafeFiles, selectionByPath, setSelectedPaths]
  );

  // Register getSelectedFiles for keyboard clipboard shortcuts
  useEffect(() => {
    if (getSelectedFilesRef) {
      getSelectedFilesRef.current = () => {
        // Aggregate selected files from all columns
        const selectedFiles: FileEntry[] = [];
        for (const path of Object.keys(selectionByPath)) {
          const selection = selectionByPath[path];
          if (selection && selection.ids.size > 0) {
            const files = getSafeFiles(path);
            for (const file of files) {
              if (selection.ids.has(file.id)) {
                selectedFiles.push(file);
              }
            }
          }
        }
        return selectedFiles;
      };
    }
    return () => {
      if (getSelectedFilesRef) {
        getSelectedFilesRef.current = null;
      }
    };
  }, [getSelectedFilesRef, selectionByPath, getSafeFiles]);

  const isHidden = (file: FileEntry) => {
    if (file.hidden === true) return true;
    const name = file.path.split(/[\\/\\]/).pop() || '';
    return name.startsWith('.');
  };

  // Helper to compute visible files for a path (with filtering, sorting, draft)
  const getVisibleFiles = React.useCallback(
    (path: string): FileEntry[] => {
      const base = getSafeFiles(path);
      const hiddenFiltered = showHidden ? base : base.filter((f) => !isHidden(f));
      let modeFiltered =
        filterMode === 'folders'
          ? hiddenFiltered.filter((f) => f.is_dir)
          : filterMode === 'files'
            ? hiddenFiltered.filter((f) => !f.is_dir)
            : hiddenFiltered;
      // Include draft new folder if applicable
      if (draftNew && draftNew.parentPath === path) {
        const draft: FileEntry = {
          id: draftNew.id,
          path: joinPaths(path, draftNew.name),
          name: draftNew.name,
          size: 0,
          modified: new Date().toISOString(),
          hidden: false,
          is_dir: true,
          custom: {},
          is_draft: true,
        };
        if (!modeFiltered.some((f) => f.id === draft.id)) {
          modeFiltered = [draft, ...modeFiltered];
        }
      }
      // Apply search filter
      const q = (searchQuery || '').trim().toLowerCase();
      const bySearch = !q
        ? modeFiltered
        : modeFiltered.filter((f) => {
            const name = f.name || f.path.split(/[/\\]/).pop() || f.path;
            return name.toLowerCase().includes(q);
          });
      // Apply sorting
      return sortFiles(bySearch, sortKey as SortKey, sortDir as SortDir);
    },
    [getSafeFiles, showHidden, filterMode, draftNew, searchQuery, sortKey, sortDir]
  );

  // Handle file selection with ctrl/shift behavior within a column
  const handleFileSelect = (
    e: React.MouseEvent | React.KeyboardEvent,
    path: string,
    index: number,
    file: FileEntry,
    visible: FileEntry[]
  ) => {
    if (e.shiftKey) {
      setSelectionByPath((prev) => {
        const state = prev[path] || { ids: new Set<string>(), anchor: null };
        const anchor = state.anchor ?? index;
        const start = Math.min(anchor, index);
        const end = Math.max(anchor, index);
        const nextIds = new Set<string>();
        for (let i = start; i <= end; i++) nextIds.add(visible[i].id);
        return { ...prev, [path]: { ids: nextIds, anchor: index } };
      });
    } else if (e.ctrlKey || e.metaKey) {
      setSelectionByPath((prev) => {
        const state = prev[path] || { ids: new Set<string>(), anchor: null };
        const nextIds = new Set(state.ids);
        if (nextIds.has(file.id)) nextIds.delete(file.id);
        else nextIds.add(file.id);
        return { ...prev, [path]: { ids: nextIds, anchor: index } };
      });
    } else {
      setSelectionByPath((prev) => ({
        ...prev,
        [path]: { ids: new Set<string>([file.id]), anchor: index },
      }));
    }
    setSelectionCursorPath(file.path);
    onFileSelect?.(file);
  };

  // Get a readable name from a path segment
  const getDisplayName = (path: string): string => {
    if (path === '.' || path === '') return 'Root';
    return path.split(/[/\\]/).pop() || path;
  };

  const scrollToLatestColumn = React.useCallback(() => {
    const el = containerRef.current;
    if (el) {
      // Use requestAnimationFrame for smoother scrolling after layout
      requestAnimationFrame(() => {
        el.scrollLeft = el.scrollWidth;
      });
    }
  }, []);

  // Auto-scroll horizontally to reveal the latest (rightmost) column,
  // similar to Finder's column view behavior.
  React.useEffect(() => {
    scrollToLatestColumn();
  }, [scrollToLatestColumn, pathStack.length, previewWidth, previewVisible]);

  // Handle window resize with debounce
  React.useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const el = containerRef.current;
        if (el) {
          // Ensure scroll position is valid after resize
          const maxScroll = el.scrollWidth - el.clientWidth;
          if (el.scrollLeft > maxScroll) {
            el.scrollLeft = Math.max(0, maxScroll);
          }
        }
      }, 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Use ResizeObserver for more responsive container resize handling
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resizeObserver = new ResizeObserver(() => {
      // Ensure scroll position stays valid when container resizes
      const maxScroll = el.scrollWidth - el.clientWidth;
      if (el.scrollLeft > maxScroll) {
        el.scrollLeft = Math.max(0, maxScroll);
      }
    });

    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, []);

  // Ref to the last column's file list for scrolling
  const lastColumnListRef = useRef<HTMLUListElement | null>(null);

  // Scroll selected item into view
  const scrollItemIntoView = useCallback(
    (index: number) => {
      const list = lastColumnListRef.current;
      if (!list) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight;
      }
    },
    [rowHeight]
  );

  // Track the previous pathStack length to detect navigation direction
  const prevPathStackLengthRef = useRef(pathStack.length);

  // Restore selection when navigating between columns
  React.useEffect(() => {
    const activePath = pathStack[pathStack.length - 1];
    if (!activePath) return;

    const visible = getVisibleFiles(activePath);
    if (visible.length === 0) return;

    const existingSelection = selectionByPath[activePath];
    if (existingSelection && existingSelection.ids.size > 0) {
      // Verify the selection is still valid
      const selectedId =
        visible.find(
          (file) => file.path === selectionCursorPath && existingSelection.ids.has(file.id)
        )?.id ?? (existingSelection.ids.values().next().value as string);
      const selectedFile = visible.find((f) => f.id === selectedId);
      const selectedIndex = visible.findIndex((f) => f.id === selectedId);

      if (selectedFile && selectedIndex >= 0) {
        // Selection is valid - update preview and scroll
        onFileSelect?.(selectedFile);
        containerRef.current?.focus();
        setTimeout(() => scrollItemIntoView(selectedIndex), 50);
        prevPathStackLengthRef.current = pathStack.length;
        return;
      }
    }

    // No valid selection - select first item only if this is a new column
    const isNewColumn = pathStack.length > prevPathStackLengthRef.current;
    if (isNewColumn || !existingSelection) {
      setSelectionByPath((prev) => ({
        ...prev,
        [activePath]: { ids: new Set([visible[0].id]), anchor: 0 },
      }));
      onFileSelect?.(visible[0]);
    }

    containerRef.current?.focus();
    prevPathStackLengthRef.current = pathStack.length;
  }, [
    pathStack,
    columnFiles,
    getVisibleFiles,
    onFileSelect,
    scrollItemIntoView,
    selectionCursorPath,
    selectionByPath,
    setSelectionByPath,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const activePath = pathStack[pathStack.length - 1];
    const visible = getVisibleFiles(activePath);
    if (visible.length === 0) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      const all = new Set(visible.map((f) => f.id));
      setSelectionByPath((prev) => ({
        ...prev,
        [activePath]: { ids: all, anchor: visible.length ? 0 : null },
      }));
      setSelectionCursorPath(visible[0]?.path ?? null);
    } else if (e.key === 'Escape') {
      setSelectionByPath((prev) => ({
        ...prev,
        [activePath]: { ids: new Set<string>(), anchor: null },
      }));
      setSelectionCursorPath(null);
      onFileSelect?.(null);
    } else if (e.key === 'F2') {
      const firstId = Array.from(selectionByPath[activePath]?.ids || [])[0] as string | undefined;
      if (firstId) {
        e.preventDefault();
        setEditingId(firstId);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const sel = selectionByPath[activePath]?.ids || new Set<string>();
      const anchor = selectionByPath[activePath]?.anchor ?? null;
      const currentIndex = (() => {
        if (anchor !== null) return anchor;
        if (sel.size > 0) {
          const idx = visible.findIndex((f) => sel.has(f.id));
          if (idx >= 0) return idx;
        }
        // If nothing selected, start from -1 for down or length for up
        return e.key === 'ArrowDown' ? -1 : visible.length;
      })();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const nextIdx = Math.min(visible.length - 1, Math.max(0, currentIndex + dir));
      const nextFile = visible[nextIdx];
      if (!nextFile) return;

      if (e.shiftKey) {
        const anc = anchor ?? Math.max(0, currentIndex);
        const a = Math.min(anc, nextIdx);
        const b = Math.max(anc, nextIdx);
        const range = new Set<string>();
        for (let i = a; i <= b; i++) range.add(visible[i].id);
        setSelectionByPath((prev) => ({
          ...prev,
          [activePath]: { ids: range, anchor: anc },
        }));
      } else {
        setSelectionByPath((prev) => ({
          ...prev,
          [activePath]: { ids: new Set([nextFile.id]), anchor: nextIdx },
        }));
      }
      // Update preview panel and scroll into view
      setSelectionCursorPath(nextFile.path);
      onFileSelect?.(nextFile);
      scrollItemIntoView(nextIdx);
    } else if (e.key === 'ArrowLeft') {
      if (pathStack.length > 1) {
        e.preventDefault();
        onColumnBack(pathStack.length - 2);
      }
    } else if (e.key === 'ArrowRight') {
      const sel = selectionByPath[activePath]?.ids || new Set<string>();
      if (sel.size === 0) return;
      const selectedId = sel.values().next().value as string | undefined;
      const entry = visible.find((f) => f.id === selectedId);
      if (entry && entry.is_dir) {
        e.preventDefault();
        // Store current selection before navigating away (ref updated immediately)
        const currentIndex = visible.findIndex((f) => f.id === selectedId);
        setSelectionByPath((prev) => ({
          ...prev,
          [activePath]: { ids: new Set([entry.id]), anchor: currentIndex },
        }));
        onFolderClick(pathStack.length - 1, entry);
      }
    }
  };

  // Keep focus on container after navigation for continued keyboard control
  React.useEffect(() => {
    // Focus after a short delay to ensure DOM is ready
    const timer = setTimeout(() => {
      const active = document.activeElement;
      const container = containerRef.current;
      // Only focus if nothing else important has focus (not an input)
      if (container && active?.tagName !== 'INPUT' && active?.tagName !== 'TEXTAREA') {
        container.focus();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [pathStack]);

  // Global ESC handler to clear selection even without focus
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setSelectionByPath((prev) => {
          const next: typeof prev = {};
          for (const k of Object.keys(prev)) {
            next[k] = { ids: new Set<string>(), anchor: null };
          }
          return next;
        });
        setSelectionCursorPath(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelectionByPath, setSelectionCursorPath]);

  // Delete handlers
  const performDelete = useCallback(
    async (files: FileEntry[], permanent: boolean = false) => {
      try {
        const refresh = async () => {
          // Trigger column refresh via setPathStack
          setPathStackStore([...(pathStackState || [])]);
        };
        const success = await deleteWithUndo(files, showToast, refresh, { permanent });
        if (success) {
          // Clear selections that contained deleted items
          setSelectionByPath((prev) => {
            const deletedIds = new Set(files.map((f) => f.id));
            const next: typeof prev = {};
            for (const k of Object.keys(prev)) {
              const filtered = new Set([...prev[k].ids].filter((id) => !deletedIds.has(id)));
              next[k] = { ids: filtered, anchor: filtered.size > 0 ? prev[k].anchor : null };
            }
            return next;
          });
        }
      } catch (e) {
        reportError('Delete failed', e, { toast: showToast });
      }
    },
    [pathStackState, setPathStackStore, showToast, setSelectionByPath]
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

  // Archive handlers
  const handleCompress = useCallback(
    (files: FileEntry[]) => {
      setArchiveDialog({
        open: true,
        mode: 'compress',
        files,
        currentPath: contextMenu.state.containerPath,
      });
    },
    [contextMenu.state.containerPath]
  );

  const handleExtract = useCallback(
    (file: FileEntry) => {
      setArchiveDialog({
        open: true,
        mode: 'extract',
        files: [file],
        currentPath: contextMenu.state.containerPath,
      });
    },
    [contextMenu.state.containerPath]
  );

  const handleArchiveClose = useCallback(() => {
    setArchiveDialog({ open: false, mode: 'compress', files: [], currentPath: '' });
  }, []);

  const handleArchiveSuccess = useCallback(() => {
    // Nudge column view refresh after archive operation
    setPathStackStore([...(pathStackState || [])]);
    setArchiveDialog({ open: false, mode: 'compress', files: [], currentPath: '' });
  }, [pathStackState, setPathStackStore]);

  return (
    <>
      <div
        className={styles.columnContainer}
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {pathStack.map((path, colIdx) => {
          const columnWidth = getColumnWidth(colIdx);
          return (
            <React.Fragment key={path}>
              <div
                className={styles.column}
                style={{
                  width: columnWidth,
                  minWidth: MIN_COLUMN_WIDTH,
                  maxWidth: MAX_COLUMN_WIDTH,
                }}
                onContextMenu={(e) => {
                  if (clipboard) contextMenu.openForEmpty(e, path);
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  const target = e.target as HTMLElement;
                  // If clicking header or a list item, don't clear
                  if (target.closest('li')) return;
                  if (target.closest(`.${styles.columnHeader}`)) return;
                  if (target.closest(`.${styles.fileList}`)) return;
                  // Don't clear when clicking resize handle
                  if (target.closest(`.${styles.columnResizeHandle}`)) return;
                  // Otherwise clear selection for this column
                  setSelectionByPath((prev) => ({
                    ...prev,
                    [path]: { ids: new Set<string>(), anchor: null },
                  }));
                  onHoverFolder?.(null);
                }}
              >
                <div
                  className={`${styles.columnHeader} ${
                    colIdx < pathStack.length - 1
                      ? styles.columnHeaderClickable
                      : styles.columnHeaderActive
                  }`}
                  tabIndex={colIdx < pathStack.length - 1 ? 0 : -1}
                  role={colIdx < pathStack.length - 1 ? 'button' : undefined}
                  aria-label={colIdx < pathStack.length - 1 ? `Go back to ${path}` : undefined}
                  title={path}
                  onClick={() => colIdx < pathStack.length - 1 && onColumnBack(colIdx)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && colIdx < pathStack.length - 1) {
                      e.preventDefault();
                      onColumnBack(colIdx);
                    }
                  }}
                >
                  {getDisplayName(path)}
                </div>
                {(() => {
                  const visible = getVisibleFiles(path);
                  const sel = selectionByPath[path]?.ids || new Set<string>();
                  return (
                    <ColumnFileList
                      path={path}
                      colIdx={colIdx}
                      visible={visible}
                      selectedIds={sel}
                      onSelectionChange={(ids, anchor) => {
                        setSelectionByPath((prev) => ({
                          ...prev,
                          [path]: { ids, anchor },
                        }));
                      }}
                      onItemClick={(e, index, entry) =>
                        handleFileSelect(e, path, index, entry, visible)
                      }
                      onFolderClick={(entry) => onFolderClick(colIdx, entry)}
                      onContextMenu={(e, entry) => {
                        const clickedInSelection = sel.has(entry.id);
                        const targetFiles = clickedInSelection
                          ? visible.filter((file) => sel.has(file.id))
                          : [entry];
                        if (!clickedInSelection) {
                          const index = visible.findIndex((file) => file.id === entry.id);
                          setSelectionByPath((prev) => ({
                            ...prev,
                            [path]: { ids: new Set([entry.id]), anchor: index },
                          }));
                          onFileSelect?.(entry);
                        }
                        contextMenu.openForFiles(e, targetFiles, path);
                      }}
                      onHoverContainerPath={onHoverContainerPath}
                      onHoverFolder={onHoverFolder}
                      dragCombineTargetId={dragCombineTargetId}
                      draggingItemIds={draggingItemIds}
                      dragStart={dragStart}
                      editingId={editingId}
                      rowHeight={rowHeight}
                      listRef={colIdx === pathStack.length - 1 ? lastColumnListRef : undefined}
                      renderEditingItem={(entry, containerPath) => (
                        <InlineRenameCol
                          key={`edit:${entry.id}`}
                          file={entry}
                          containerPath={containerPath}
                          onDone={(committed, newName) => {
                            (async () => {
                              try {
                                if (!committed) {
                                  if (entry.is_draft) setDraftNew(null);
                                  setEditingId(null);
                                  return;
                                }
                                const name = (newName || '').trim();
                                if (!name) {
                                  if (entry.is_draft) setDraftNew(null);
                                  setEditingId(null);
                                  return;
                                }
                                if (entry.is_draft) {
                                  await createFolderIn(containerPath, name);
                                  setDraftNew(null);
                                } else {
                                  await renamePath(entry.path, name);
                                }
                                // Nudge column view refresh
                                setPathStackStore([...(pathStackState || [])]);
                              } catch (error) {
                                const index = visible.findIndex((file) => file.id === entry.id);
                                setSelectionByPath((prev) => ({
                                  ...prev,
                                  [containerPath]: {
                                    ids: new Set([entry.id]),
                                    anchor: index >= 0 ? index : null,
                                  },
                                }));
                                reportError('Rename failed', error, {
                                  toast: showToast,
                                  context: { path: entry.path },
                                });
                              } finally {
                                setEditingId(null);
                              }
                            })();
                          }}
                        />
                      )}
                    />
                  );
                })()}
              </div>
              <ColumnResizeHandle
                colIdx={colIdx}
                currentWidth={columnWidth}
                onResize={setColumnWidth}
              />
            </React.Fragment>
          );
        })}
      </div>
      <ContextMenu
        state={contextMenu.state}
        onClose={contextMenu.close}
        onRename={(file) => setEditingId(file.id)}
        onRefresh={() => {
          // Trigger column refresh via setPathStack
          setPathStackStore([...(pathStackState || [])]);
        }}
        confirmBeforeDelete={confirmBeforeDelete}
        onDeleteConfirm={(files) => setDeleteConfirm({ open: true, files })}
        onCompress={handleCompress}
        onExtract={handleExtract}
      />
      {archiveDialog.open && (
        <React.Suspense fallback={null}>
          <LazyArchiveDialog
            open={archiveDialog.open}
            mode={archiveDialog.mode}
            files={archiveDialog.files}
            currentPath={archiveDialog.currentPath}
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
    </>
  );
}

/**
 * ColumnView displays files in a Finder-style multi-column browser.
 *
 * Features:
 * - Multi-column navigation (each folder selection reveals contents in next column)
 * - Resizable columns with drag handles (double-click to reset)
 * - Column width persistence to localStorage
 * - Multi-select with Shift/Ctrl modifiers
 * - Drag-and-drop support for file operations
 * - Context menu integration
 * - Keyboard navigation (arrow keys between columns and items)
 * - Auto-scroll to rightmost column on folder selection
 *
 * @example
 * ```tsx
 * <ColumnView
 *   pathStack={["/Users/me", "/Users/me/Documents"]}
 *   columnFiles={{
 *     "/Users/me": homeFiles,
 *     "/Users/me/Documents": docFiles,
 *   }}
 *   onFolderClick={(colIdx, entry) => expandColumn(colIdx, entry)}
 *   onColumnBack={(colIdx) => collapseColumn(colIdx)}
 * />
 * ```
 */
export const ColumnView = React.memo(ColumnViewInner);

function InlineRenameCol({
  file,
  containerPath: _containerPath,
  onDone,
}: {
  file: FileEntry;
  containerPath: string;
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
