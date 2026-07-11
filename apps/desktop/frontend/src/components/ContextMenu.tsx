import React, { useRef, useEffect, useLayoutEffect, useCallback, useState, useId } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { Icon } from './Icon';
import styles from './ContextMenu.module.css';
import {
  deleteWithUndo,
  moveWithUndoAndConflictResolution,
  copyWithUndoAndConflictResolution,
} from '../utils/fileOperations';
import { useOperationQueueStore } from '../operationQueueStore';
import { useToast } from './Toast';
import type { Toast } from './Toast';
import { basename, normalizePathForCompare } from '../utils/path';
import { reportError } from '../utils/errorReporter';
import type { AppInfo } from '../services/finderIntegration';
import {
  revealInFileManager,
  quickLook,
  isQuickLookAvailable,
  isOpenWithAvailable,
  getAppsForFile,
  openWithApp,
} from '../services/finderIntegration';

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  /** The file(s) right-clicked on, or null if clicking empty space */
  files: FileEntry[];
  /** The container path where the context menu was opened */
  containerPath: string;
  /** Element that should regain focus when the menu closes */
  focusTarget?: HTMLElement | null;
}

export const initialContextMenuState: ContextMenuState = {
  open: false,
  x: 0,
  y: 0,
  files: [],
  containerPath: '',
  focusTarget: null,
};

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  /** Called when rename is requested for a file */
  onRename?: (file: FileEntry) => void;
  /** Called when batch rename is requested for multiple files */
  onBatchRename?: (files: FileEntry[]) => void;
  /** Called after a successful delete/paste to refresh the file list */
  onRefresh?: () => void | Promise<void>;
  /** Whether to show delete confirmation dialog */
  confirmBeforeDelete?: boolean;
  /** Called when delete confirmation is needed (passes files to delete) */
  onDeleteConfirm?: (files: FileEntry[]) => void;
  /** Called when compress is requested */
  onCompress?: (files: FileEntry[]) => void;
  /** Called when extract is requested for an archive file */
  onExtract?: (file: FileEntry) => void;
  /** Called when compare is requested for two files */
  onCompare?: (files: FileEntry[]) => void;
  /** File marked for comparison (first file selected) */
  compareTarget?: FileEntry | null;
  /** Called to set a file as comparison target */
  onSetCompareTarget?: (file: FileEntry | null) => void;
}

// Helper to check if a file is an archive
function isArchiveFile(file: FileEntry): boolean {
  const name = (file.name || file.path).toLowerCase();
  return (
    name.endsWith('.zip') ||
    name.endsWith('.tar.gz') ||
    name.endsWith('.tgz') ||
    name.endsWith('.tar') ||
    name.endsWith('.7z') ||
    name.endsWith('.rar')
  );
}

/**
 * Shared context menu component for file operations.
 * Handles Rename, Copy, Cut, Delete, and Paste operations.
 */
// Helper to check if a file is a text file (suitable for comparison)
function isTextFile(file: FileEntry): boolean {
  const name = (file.name || file.path).toLowerCase();
  const textExtensions = [
    '.txt',
    '.md',
    '.json',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.css',
    '.scss',
    '.html',
    '.htm',
    '.xml',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.bat',
    '.cmd',
    '.py',
    '.rb',
    '.php',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.go',
    '.rs',
    '.swift',
    '.kt',
    '.scala',
    '.clj',
    '.ex',
    '.exs',
    '.sql',
    '.graphql',
    '.vue',
    '.svelte',
    '.astro',
    '.env',
    '.gitignore',
    '.editorconfig',
    '.prettierrc',
    '.eslintrc',
    'makefile',
    'dockerfile',
    'readme',
    'license',
    'changelog',
  ];
  return textExtensions.some((ext) => name.endsWith(ext) || name === ext.slice(1));
}

export function ContextMenu({
  state,
  onClose,
  onRename,
  onBatchRename,
  onRefresh,
  confirmBeforeDelete = false,
  onDeleteConfirm,
  onCompress,
  onExtract,
  onCompare,
  compareTarget,
  onSetCompareTarget,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const clipboard = useFileStore((s) => s.clipboard);
  const setClipboard = useFileStore((s) => s.setClipboard);
  const addFavorite = useFileStore((s) => s.addFavorite);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const favorites = useFileStore((s) => s.favorites);
  const menuId = useId();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [quickLookAvailable, setQuickLookAvailable] = useState(false);
  const [openWithAvailable, setOpenWithAvailable] = useState(false);
  const [openWithApps, setOpenWithApps] = useState<AppInfo[]>([]);
  const [openWithExpanded, setOpenWithExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [position, setPosition] = useState({ x: state.x, y: state.y });

  useLayoutEffect(() => {
    if (!state.open || !menuRef.current) return;
    const gutter = 8;
    const rect = menuRef.current.getBoundingClientRect();
    const maxX = Math.max(gutter, window.innerWidth - rect.width - gutter);
    const maxY = Math.max(gutter, window.innerHeight - rect.height - gutter);
    setPosition({
      x: Math.min(Math.max(gutter, state.x), maxX),
      y: Math.min(Math.max(gutter, state.y), maxY),
    });
  }, [state.open, state.x, state.y, openWithExpanded, openWithApps.length, advancedExpanded]);

  useEffect(() => {
    if (!state.open) return;
    const focusTarget = state.focusTarget;
    return () => {
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    };
  }, [state.open, state.focusTarget]);

  // Check if Quick Look and Open With are available (macOS only)
  useEffect(() => {
    isQuickLookAvailable()
      .then(setQuickLookAvailable)
      .catch(() => setQuickLookAvailable(false));
    isOpenWithAvailable()
      .then(setOpenWithAvailable)
      .catch(() => setOpenWithAvailable(false));
  }, []);

  // Load apps for "Open With" when menu opens with a single file
  useEffect(() => {
    if (!state.open || !openWithAvailable || state.files.length !== 1 || state.files[0].is_dir) {
      setOpenWithApps([]);
      setOpenWithExpanded(false);
      return;
    }

    getAppsForFile(state.files[0].path)
      .then(setOpenWithApps)
      .catch(() => setOpenWithApps([]));
  }, [state.open, state.files, openWithAvailable]);

  // Get toast function for undo notifications - will throw if not in ToastProvider
  // Use optional try/catch for compatibility with contexts outside ToastProvider
  let showToast:
    | ((message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) => void)
    | null = null;
  try {
    const toast = useToast();
    showToast = toast.show;
  } catch {
    // Not in ToastProvider context, showToast remains null
  }

  // Close menu on outside click
  useEffect(() => {
    if (!state.open) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      onClose();
    };

    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [state.open, onClose]);

  // Focus first menu item when menu opens
  useEffect(() => {
    if (!state.open || !menuRef.current) return;

    setFocusedIndex(0);
    setAdvancedExpanded(false);
    const items = menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items.length > 0) {
      items[0].focus();
    }
  }, [state.open, state.files]);

  // Keyboard navigation for menu items
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!menuRef.current) return;

      const items = menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]');
      const itemCount = items.length;
      if (itemCount === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          const nextIndex = (focusedIndex + 1) % itemCount;
          setFocusedIndex(nextIndex);
          items[nextIndex].focus();
          break;
        case 'ArrowUp':
          e.preventDefault();
          const prevIndex = (focusedIndex - 1 + itemCount) % itemCount;
          setFocusedIndex(prevIndex);
          items[prevIndex].focus();
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          items[0].focus();
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(itemCount - 1);
          items[itemCount - 1].focus();
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'Tab':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [focusedIndex, onClose]
  );

  const handleRename = useCallback(() => {
    if (state.files.length === 1 && onRename) {
      onRename(state.files[0]);
    }
    onClose();
  }, [state.files, onRename, onClose]);

  const handleBatchRename = useCallback(() => {
    if (state.files.length > 1 && onBatchRename) {
      onBatchRename(state.files);
    }
    onClose();
  }, [state.files, onBatchRename, onClose]);

  const handleCopy = useCallback(() => {
    if (state.files.length > 0) {
      setClipboard({
        mode: 'copy',
        items: state.files,
        sourcePath: state.containerPath,
      });
    }
    onClose();
  }, [state.files, state.containerPath, setClipboard, onClose]);

  const handleCut = useCallback(() => {
    if (state.files.length > 0) {
      setClipboard({
        mode: 'cut',
        items: state.files,
        sourcePath: state.containerPath,
      });
    }
    onClose();
  }, [state.files, state.containerPath, setClipboard, onClose]);

  const handleDelete = useCallback(async () => {
    if (state.files.length === 0) {
      onClose();
      return;
    }

    if (confirmBeforeDelete && onDeleteConfirm) {
      onDeleteConfirm(state.files);
      onClose();
      return;
    }

    try {
      await deleteWithUndo(state.files, showToast ?? (() => {}), onRefresh ?? (() => {}));
    } catch (e) {
      reportError('Delete failed', e, { toast: showToast });
    }
    onClose();
  }, [state.files, confirmBeforeDelete, onDeleteConfirm, onRefresh, onClose, showToast]);

  const handlePaste = useCallback(async () => {
    if (!clipboard || !state.containerPath) {
      onClose();
      return;
    }

    // Get conflict resolution setting from operation queue store and map to our options
    const storeResolution = useOperationQueueStore.getState().defaultConflictResolution;
    // Map 'rename' to 'keepBoth' since they achieve the same goal
    const conflictResolution = storeResolution === 'rename' ? 'keepBoth' : storeResolution;

    try {
      const notify = showToast ?? (() => {});
      const refresh = onRefresh ?? (() => {});
      if (clipboard.mode === 'cut') {
        await moveWithUndoAndConflictResolution(
          clipboard.items,
          state.containerPath,
          notify,
          refresh,
          { conflictResolution: conflictResolution as 'skip' | 'replace' | 'keepBoth' | 'ask' }
        );
        setClipboard(null);
      } else if (clipboard.mode === 'copy') {
        await copyWithUndoAndConflictResolution(
          clipboard.items,
          state.containerPath,
          notify,
          refresh,
          { conflictResolution: conflictResolution as 'skip' | 'replace' | 'keepBoth' | 'ask' }
        );
      }
    } catch (e) {
      reportError('Paste failed', e, { toast: showToast });
    }
    onClose();
  }, [clipboard, state.containerPath, setClipboard, onRefresh, onClose, showToast]);

  // Check if selected folder is in favorites
  const isFavorite = useCallback(
    (file: FileEntry) => {
      const normPath = normalizePathForCompare(file.path);
      return favorites.some((f) => normalizePathForCompare(f.path) === normPath);
    },
    [favorites]
  );

  const handleAddToFavorites = useCallback(() => {
    if (state.files.length === 1 && state.files[0].is_dir) {
      addFavorite(state.files[0].path);
    }
    onClose();
  }, [state.files, addFavorite, onClose]);

  const handleRemoveFromFavorites = useCallback(() => {
    if (state.files.length === 1 && state.files[0].is_dir) {
      removeFavorite(state.files[0].path);
    }
    onClose();
  }, [state.files, removeFavorite, onClose]);

  const handleCompress = useCallback(() => {
    if (state.files.length > 0 && onCompress) {
      onCompress(state.files);
    }
    onClose();
  }, [state.files, onCompress, onClose]);

  const handleExtract = useCallback(() => {
    if (state.files.length === 1 && isArchiveFile(state.files[0]) && onExtract) {
      onExtract(state.files[0]);
    }
    onClose();
  }, [state.files, onExtract, onClose]);

  // Mark file for comparison
  const handleMarkForCompare = useCallback(() => {
    if (state.files.length === 1 && onSetCompareTarget) {
      onSetCompareTarget(state.files[0]);
    }
    onClose();
  }, [state.files, onSetCompareTarget, onClose]);

  // Compare with marked file
  const handleCompareWith = useCallback(() => {
    if (state.files.length === 1 && compareTarget && onCompare) {
      onCompare([compareTarget, state.files[0]]);
      onSetCompareTarget?.(null); // Clear the target after comparison
    }
    onClose();
  }, [state.files, compareTarget, onCompare, onSetCompareTarget, onClose]);

  // Compare two selected files directly
  const handleCompareTwoFiles = useCallback(() => {
    if (state.files.length === 2 && onCompare) {
      onCompare(state.files);
    }
    onClose();
  }, [state.files, onCompare, onClose]);

  // Reveal in native file manager (Finder on macOS, Explorer on Windows)
  const handleRevealInFileManager = useCallback(async () => {
    if (state.files.length === 1) {
      try {
        await revealInFileManager(state.files[0].path);
      } catch (e) {
        reportError('Failed to reveal in file manager', e, { toast: showToast });
      }
    }
    onClose();
  }, [state.files, onClose, showToast]);

  // Quick Look preview (macOS only)
  const handleQuickLook = useCallback(async () => {
    if (state.files.length === 1) {
      try {
        await quickLook(state.files[0].path);
      } catch (e) {
        reportError('Quick Look failed', e, { toast: showToast });
      }
    }
    onClose();
  }, [state.files, onClose, showToast]);

  // Open With specific app (macOS only)
  const handleOpenWithApp = useCallback(
    async (app: AppInfo) => {
      if (state.files.length === 1) {
        try {
          await openWithApp(state.files[0].path, app.name);
        } catch (e) {
          reportError(`Failed to open with ${app.name}`, e, { toast: showToast });
        }
      }
      onClose();
    },
    [state.files, onClose, showToast]
  );

  // Toggle Open With submenu
  const handleOpenWithToggle = useCallback(() => {
    setOpenWithExpanded((prev) => !prev);
  }, []);

  if (!state.open) return null;

  const hasFiles = state.files.length > 0;
  const isMultiple = state.files.length > 1;
  const hasClipboard = !!clipboard;
  const showPaste = !hasFiles && hasClipboard;
  const isSingleFolder = state.files.length === 1 && state.files[0].is_dir;
  const singleFolderIsFavorite = isSingleFolder && isFavorite(state.files[0]);
  const isSingleArchive = state.files.length === 1 && isArchiveFile(state.files[0]);
  const canCompress = hasFiles && onCompress;
  const canExtract = isSingleArchive && onExtract;
  const canCompare =
    !!onCompare &&
    ((state.files.length === 1 && !state.files[0].is_dir && isTextFile(state.files[0])) ||
      (state.files.length === 2 && state.files.every((file) => !file.is_dir && isTextFile(file))));
  const fileManagerName =
    document.documentElement.dataset.platform === 'macos'
      ? 'Finder'
      : document.documentElement.dataset.platform === 'windows'
        ? 'Explorer'
        : 'File Manager';

  // Don't render if nothing to show
  if (!hasFiles && !showPaste) return null;

  return (
    <div
      ref={menuRef}
      id={menuId}
      className={styles.contextMenu}
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={
        hasFiles
          ? `Actions for ${state.files.length} selected item${state.files.length > 1 ? 's' : ''}`
          : 'Paste menu'
      }
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {hasFiles && (
        <>
          {/* Rename - only for single file */}
          {!isMultiple && onRename && (
            <div
              className={styles.contextItem}
              role="menuitem"
              tabIndex={-1}
              onClick={handleRename}
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            >
              <span className={styles.contextIcon} aria-hidden="true">
                <Icon name="edit" />
              </span>
              Rename
            </div>
          )}

          {/* Batch Rename - only for multiple files */}
          {isMultiple && onBatchRename && (
            <div
              className={styles.contextItem}
              role="menuitem"
              tabIndex={-1}
              onClick={handleBatchRename}
              onKeyDown={(e) => e.key === 'Enter' && handleBatchRename()}
            >
              <span className={styles.contextIcon} aria-hidden="true">
                <Icon name="edit" />
              </span>
              Batch Rename ({state.files.length})
            </div>
          )}

          {/* Copy */}
          <div
            className={styles.contextItem}
            role="menuitem"
            tabIndex={-1}
            onClick={handleCopy}
            onKeyDown={(e) => e.key === 'Enter' && handleCopy()}
          >
            <span className={styles.contextIcon} aria-hidden="true">
              <Icon name="copy" />
            </span>
            Copy{isMultiple ? ` (${state.files.length})` : ''}
          </div>

          {/* Cut */}
          <div
            className={styles.contextItem}
            role="menuitem"
            tabIndex={-1}
            onClick={handleCut}
            onKeyDown={(e) => e.key === 'Enter' && handleCut()}
          >
            <span className={styles.contextIcon} aria-hidden="true">
              <Icon name="cut" />
            </span>
            Cut{isMultiple ? ` (${state.files.length})` : ''}
          </div>

          {/* Delete */}
          <div
            className={styles.contextItem}
            role="menuitem"
            tabIndex={-1}
            onClick={handleDelete}
            onKeyDown={(e) => e.key === 'Enter' && handleDelete()}
          >
            <span className={styles.contextIcon} aria-hidden="true">
              <Icon name="trash" />
            </span>
            Delete{isMultiple ? ` (${state.files.length})` : ''}
          </div>

          {/* Reveal in File Manager / Quick Look - only for single file */}
          {!isMultiple && (
            <>
              <div className={styles.separator} role="separator" />
              <div
                className={styles.contextItem}
                role="menuitem"
                tabIndex={-1}
                onClick={handleRevealInFileManager}
                onKeyDown={(e) => e.key === 'Enter' && handleRevealInFileManager()}
              >
                <span className={styles.contextIcon} aria-hidden="true">
                  <Icon name="folder-open" />
                </span>
                Show in {fileManagerName}
              </div>
              {/* Quick Look - macOS only */}
              {quickLookAvailable && !state.files[0]?.is_dir && (
                <div
                  className={styles.contextItem}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={handleQuickLook}
                  onKeyDown={(e) => e.key === 'Enter' && handleQuickLook()}
                >
                  <span className={styles.contextIcon} aria-hidden="true">
                    <Icon name="eye" />
                  </span>
                  Quick Look
                </div>
              )}
              {/* Open With - macOS only, files only */}
              {openWithAvailable && !state.files[0]?.is_dir && openWithApps.length > 0 && (
                <div className={styles.submenuContainer}>
                  <div
                    className={styles.contextItem}
                    role="menuitem"
                    tabIndex={-1}
                    onClick={handleOpenWithToggle}
                    onKeyDown={(e) => e.key === 'Enter' && handleOpenWithToggle()}
                    aria-haspopup="true"
                    aria-expanded={openWithExpanded}
                  >
                    <span className={styles.contextIcon} aria-hidden="true">
                      <Icon name="external-link" />
                    </span>
                    Open With
                    <span className={styles.submenuArrow} aria-hidden="true">
                      <Icon name={openWithExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                    </span>
                  </div>
                  {openWithExpanded && (
                    <div className={styles.submenu} role="menu">
                      {openWithApps.map((app) => (
                        <div
                          key={app.bundle_id || app.path || app.name}
                          className={styles.contextItem}
                          role="menuitem"
                          tabIndex={-1}
                          onClick={() => handleOpenWithApp(app)}
                          onKeyDown={(e) => e.key === 'Enter' && handleOpenWithApp(app)}
                        >
                          <span className={styles.contextIcon} aria-hidden="true">
                            <Icon name="app-window" />
                          </span>
                          {app.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Add/Remove from Favorites - only for single folder */}
          {isSingleFolder && (
            <>
              <div className={styles.separator} role="separator" />
              {singleFolderIsFavorite ? (
                <div
                  className={styles.contextItem}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={handleRemoveFromFavorites}
                  onKeyDown={(e) => e.key === 'Enter' && handleRemoveFromFavorites()}
                >
                  <span className={styles.contextIcon} aria-hidden="true">
                    <Icon name="star" />
                  </span>
                  Remove from Favorites
                </div>
              ) : (
                <div
                  className={styles.contextItem}
                  role="menuitem"
                  tabIndex={-1}
                  onClick={handleAddToFavorites}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddToFavorites()}
                >
                  <span className={styles.contextIcon} aria-hidden="true">
                    <Icon name="star" />
                  </span>
                  Add to Favorites
                </div>
              )}
            </>
          )}

          {(canCompress || canExtract || canCompare) && (
            <>
              <div className={styles.separator} role="separator" />
              <div
                className={styles.contextItem}
                role="menuitem"
                tabIndex={-1}
                onClick={() => setAdvancedExpanded((value) => !value)}
                onKeyDown={(event) =>
                  event.key === 'Enter' && setAdvancedExpanded((value) => !value)
                }
                aria-haspopup="true"
                aria-expanded={advancedExpanded}
              >
                <span className={styles.contextIcon} aria-hidden="true">
                  <Icon name="settings" />
                </span>
                Advanced
                <span className={styles.submenuArrow} aria-hidden="true">
                  <Icon name={advancedExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
              </div>
              {advancedExpanded && (
                <div className={styles.submenu} role="group" aria-label="Advanced actions">
                  {/* Compress - available for any selection */}
                  {canCompress && (
                    <div
                      className={styles.contextItem}
                      role="menuitem"
                      tabIndex={-1}
                      onClick={handleCompress}
                      onKeyDown={(e) => e.key === 'Enter' && handleCompress()}
                    >
                      <span className={styles.contextIcon} aria-hidden="true">
                        <Icon name="archive" />
                      </span>
                      Compress{isMultiple ? ` (${state.files.length})` : ''}
                    </div>
                  )}

                  {/* Extract - only for archive files */}
                  {canExtract && (
                    <div
                      className={styles.contextItem}
                      role="menuitem"
                      tabIndex={-1}
                      onClick={handleExtract}
                      onKeyDown={(e) => e.key === 'Enter' && handleExtract()}
                    >
                      <span className={styles.contextIcon} aria-hidden="true">
                        <Icon name="unarchive" />
                      </span>
                      Extract Here
                    </div>
                  )}

                  {/* Compare operations - for text files */}
                  {canCompare && (
                    <>
                      {/* Compare two selected files directly */}
                      {state.files.length === 2 &&
                        !state.files[0].is_dir &&
                        !state.files[1].is_dir &&
                        isTextFile(state.files[0]) &&
                        isTextFile(state.files[1]) && (
                          <>
                            <div className={styles.separator} role="separator" />
                            <div
                              className={styles.contextItem}
                              role="menuitem"
                              tabIndex={-1}
                              onClick={handleCompareTwoFiles}
                              onKeyDown={(e) => e.key === 'Enter' && handleCompareTwoFiles()}
                            >
                              <span className={styles.contextIcon} aria-hidden="true">
                                <Icon name="git-compare" />
                              </span>
                              Compare Files
                            </div>
                          </>
                        )}

                      {/* Single file compare options */}
                      {state.files.length === 1 &&
                        !state.files[0].is_dir &&
                        isTextFile(state.files[0]) && (
                          <>
                            <div className={styles.separator} role="separator" />
                            {/* If there's a compare target and it's different from current file */}
                            {compareTarget && compareTarget.id !== state.files[0].id ? (
                              <>
                                <div
                                  className={styles.contextItem}
                                  role="menuitem"
                                  tabIndex={-1}
                                  onClick={handleCompareWith}
                                  onKeyDown={(e) => e.key === 'Enter' && handleCompareWith()}
                                >
                                  <span className={styles.contextIcon} aria-hidden="true">
                                    <Icon name="git-compare" />
                                  </span>
                                  Compare with "{compareTarget.name || basename(compareTarget.path)}
                                  "
                                </div>
                                <div
                                  className={styles.contextItem}
                                  role="menuitem"
                                  tabIndex={-1}
                                  onClick={handleMarkForCompare}
                                  onKeyDown={(e) => e.key === 'Enter' && handleMarkForCompare()}
                                >
                                  <span className={styles.contextIcon} aria-hidden="true">
                                    <Icon name="crosshair" />
                                  </span>
                                  Mark for Compare (replace)
                                </div>
                              </>
                            ) : (
                              <div
                                className={styles.contextItem}
                                role="menuitem"
                                tabIndex={-1}
                                onClick={handleMarkForCompare}
                                onKeyDown={(e) => e.key === 'Enter' && handleMarkForCompare()}
                              >
                                <span className={styles.contextIcon} aria-hidden="true">
                                  <Icon name="crosshair" />
                                </span>
                                Mark for Compare
                              </div>
                            )}
                          </>
                        )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Paste - only when clicking empty space and clipboard has items */}
      {showPaste && (
        <div
          className={styles.contextItem}
          role="menuitem"
          tabIndex={-1}
          onClick={handlePaste}
          onKeyDown={(e) => e.key === 'Enter' && handlePaste()}
        >
          <span className={styles.contextIcon} aria-hidden="true">
            <Icon name="clipboard" />
          </span>
          Paste{clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
        </div>
      )}
    </div>
  );
}

/**
 * Hook to manage context menu state and event handlers.
 */
export function useContextMenu() {
  const [state, setState] = React.useState<ContextMenuState>(initialContextMenuState);

  const open = useCallback((e: React.MouseEvent, files: FileEntry[], containerPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setState({
      open: true,
      x: e.clientX,
      y: e.clientY,
      files,
      containerPath,
      focusTarget:
        e.currentTarget instanceof HTMLElement
          ? e.currentTarget
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    });
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const openForFiles = useCallback(
    (e: React.MouseEvent, files: FileEntry[], containerPath: string) => {
      open(e, files, containerPath);
    },
    [open]
  );

  const openForEmpty = useCallback(
    (e: React.MouseEvent, containerPath: string) => {
      open(e, [], containerPath);
    },
    [open]
  );

  return {
    state,
    open,
    close,
    openForFiles,
    openForEmpty,
  };
}

export default ContextMenu;
