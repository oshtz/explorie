import React from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { joinPaths } from '../utils/fs';
import type { SortKey, SortDir } from './FileTable';
import { FileTable } from './FileTable';
import styles from './ListView.module.css';
import { Icon } from './Icon';
import { useShallow } from 'zustand/shallow';
import type { GetSelectedFilesFunction } from '../hooks/useKeyboardClipboard';

/**
 * Props for the ListView component.
 */
interface ListViewProps {
  /** Current directory path being displayed */
  currentPath: string;
  /** Array of file entries to display in the list */
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

function ListViewInner({
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
}: ListViewProps) {
  // Sorting and selection are driven by global store for consistency across views
  const {
    showHidden,
    filterMode,
    searchQuery,
    sortKey,
    sortDir,
    setSort,
    showFolderSizesEnabled,
    draftNew,
  } = useFileStore(
    useShallow((s) => ({
      showHidden: s.showHidden,
      filterMode: s.filterMode,
      searchQuery: s.searchQuery,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
      setSort: s.setSort,
      showFolderSizesEnabled: s.showFolderSizes,
      draftNew: s.draftNew,
    }))
  );

  // Defensive: ensure files is an array to prevent runtime crashes
  const safeFiles = React.useMemo<FileEntry[]>(() => {
    if (Array.isArray(files)) return files;
    try {
      console.warn("ListView: 'files' prop is not an array. Rendering empty list.", files);
    } catch {}
    return [];
  }, [files]);

  const isHidden = (file: FileEntry) => {
    if (file.hidden === true) return true;
    const name = file.path.split(/[\/\\]/).pop() || '';
    return name.startsWith('.');
  };
  const visibleFiles = React.useMemo(() => {
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
          const name = f.name || f.path.split(/[\\/\\]/).pop() || f.path;
          return name.toLowerCase().includes(q);
        });
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
  }, [showHidden, safeFiles, filterMode, searchQuery, draftNew, currentPath]);

  // Handle sort toggling with debounce to avoid rapid resorting
  const sortTimer = React.useRef<number | null>(null);
  const handleSort = (key: SortKey) => {
    if (sortTimer.current) {
      window.clearTimeout(sortTimer.current);
      sortTimer.current = null;
    }
    sortTimer.current = window.setTimeout(() => {
      setSort(key);
    }, 120);
  };

  // Handle file selection with local state
  const handleFileSelect = (file: FileEntry) => {
    onFileSelect?.(file);
  };

  return (
    <div className={styles.listViewContainer}>
      {visibleFiles.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <FileTable
            droppableId={`list:${currentPath}`}
            files={visibleFiles}
            sortKey={sortKey as SortKey}
            sortDir={sortDir as SortDir}
            onSort={handleSort}
            onFileSelect={handleFileSelect}
            onFolderOpen={onFolderOpen}
            combineTargetId={dragCombineTargetId}
            showFolderSizesEnabled={showFolderSizesEnabled}
            isDragging={isDragging}
            draggingItemId={draggingItemId}
            onBeginDrag={onBeginDrag}
            onHoverFolder={onHoverFolder}
            onHoverContainer={onHoverContainer}
            getSelectedFilesRef={getSelectedFilesRef}
          />
        </div>
      ) : (
        <div className={styles.emptyState}>
          <div className={styles.emptyStateIcon}>
            <Icon name="folder" size={20} />
          </div>
          <div className={styles.emptyStateText}>This folder is empty</div>
          <div className={styles.emptyStateSubtext}>Drop files here or use the create button</div>
        </div>
      )}
    </div>
  );
}

/**
 * ListView displays files in a traditional table format with sortable columns.
 *
 * Features:
 * - Sortable columns (name, size, modified date, custom fields)
 * - Virtual scrolling for large directories
 * - Multi-select with Shift/Ctrl modifiers
 * - Drag-and-drop support for file operations
 * - Context menu integration
 * - Keyboard navigation (arrow keys, Enter to open)
 *
 * @example
 * ```tsx
 * <ListView
 *   currentPath="/Users/me/Documents"
 *   files={entries}
 *   onFileSelect={(file) => setSelected(file)}
 *   onFolderOpen={(folder) => navigate(folder.path)}
 * />
 * ```
 */
export const ListView = React.memo(ListViewInner);
