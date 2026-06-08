import React, { useState, useMemo, useCallback, useEffect, useId } from 'react';
import styles from './TopBar.module.css'; // Import CSS Module
import type { ViewMode } from './ViewModeToggle';
import type { SortKey } from './FileTable';
import type { FileEntry, SmartFolderCriteria } from '../store';
import { useFileStore } from '../store'; // Import store directly
import { Icon } from './Icon';
import type { IconName } from '../icons';
import { createNoteIn, createWebsiteLinkIn } from '../utils/fs';
import { invoke } from '@tauri-apps/api/core';
import { debounce } from '../utils/debounce';
import { Breadcrumbs } from './Breadcrumbs';
import { ThumbnailSizeSlider } from './ThumbnailSizeSlider';
import { useUndoRedoStore, useCanUndo, useCanRedo } from '../undoRedoStore';
import { basename } from '../utils/path';
import { useToast } from './Toast';
import { reportError } from '../utils/errorReporter';

interface TopBarProps {
  currentPath: string;
  onUp?: () => void;
  onNavigate?: (path: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  // Navigation history
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  // History dropdown
  backHistory?: string[];
  forwardHistory?: string[];
  onBackHistorySelect?: (index: number) => void;
  onForwardHistorySelect?: (index: number) => void;
}

export function TopBar({
  currentPath,
  onUp,
  onNavigate,
  viewMode,
  setViewMode: _setViewModeProp,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  backHistory = [],
  forwardHistory = [],
  onBackHistorySelect,
  onForwardHistorySelect,
}: TopBarProps) {
  const isDevBuild = import.meta.env.DEV;
  const { show: showToast } = useToast();
  // Get the setViewMode function directly from the store
  const {
    setViewMode: setViewModeStore,
    theme,
    setTheme,
    showHidden,
    setShowHidden,
    showPreviewPanel,
    setShowPreviewPanel,
    showFolderSizes,
    setShowFolderSizes,
    sortKey,
    sortDir,
    setSort,
    enableDnDLargeLists,
    setEnableDnDLargeLists,
    devMockEntries,
    setDevMockEntries,
    filterMode,
    setFilterMode,
    searchQuery,
    setSearchQuery,
    setFiles,
    pathStack,
    setPathStack,
    addSmartFolder,
  } = useFileStore();
  // Local search input state for immediate feedback, debounced to store
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);

  // Create debounced setter for store
  const debouncedSetSearchQuery = useMemo(
    () => debounce((value: string) => setSearchQuery(value), 150),
    [setSearchQuery]
  );

  // Sync local state when store changes (e.g., from clear button or external source)
  useEffect(() => {
    setLocalSearchQuery(searchQuery);
  }, [searchQuery]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => debouncedSetSearchQuery.cancel();
  }, [debouncedSetSearchQuery]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalSearchQuery(value); // Immediate local update
      debouncedSetSearchQuery(value); // Debounced store update
    },
    [debouncedSetSearchQuery]
  );

  const handleSearchClear = useCallback(() => {
    setLocalSearchQuery('');
    setSearchQuery('');
    debouncedSetSearchQuery.cancel();
  }, [setSearchQuery, debouncedSetSearchQuery]);

  // Save current search as a Smart Folder
  const handleSaveSearch = useCallback(() => {
    if (!localSearchQuery.trim()) return;

    const name = window.prompt(
      'Enter a name for this saved search:',
      `Search: ${localSearchQuery}`
    );
    if (!name?.trim()) return;

    const criteria: SmartFolderCriteria = {
      namePattern: localSearchQuery,
      searchPaths: [currentPath],
      recursive: true,
      typeFilter: filterMode === 'all' ? 'all' : filterMode === 'folders' ? 'folders' : 'files',
    };

    addSmartFolder(name.trim(), criteria);

    showToast(`Smart folder saved: ${name.trim()}`, { type: 'success' });
  }, [localSearchQuery, currentPath, filterMode, addSmartFolder, showToast]);

  // Popover state and anchor ref managed here
  const [popoverOpen, setPopoverOpen] = useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null); // anchor for popover toggle
  const popoverRef = React.useRef<HTMLDivElement>(null); // popover container
  // More actions popover
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreButtonRef = React.useRef<HTMLButtonElement>(null);
  const morePopoverRef = React.useRef<HTMLDivElement>(null);
  // Create popover
  const [createOpen, setCreateOpen] = React.useState(false);
  const createButtonRef = React.useRef<HTMLButtonElement>(null);
  const createPopoverRef = React.useRef<HTMLDivElement>(null);
  // Sort popover
  const [sortOpen, setSortOpen] = React.useState(false);
  const sortButtonRef = React.useRef<HTMLButtonElement>(null);
  const sortPopoverRef = React.useRef<HTMLDivElement>(null);
  // Filter popover
  const [filterOpen, setFilterOpen] = React.useState(false);
  const filterButtonRef = React.useRef<HTMLButtonElement>(null);
  const filterPopoverRef = React.useRef<HTMLDivElement>(null);
  // Back/Forward history dropdowns
  const [backHistoryOpen, setBackHistoryOpen] = React.useState(false);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const backPopoverRef = React.useRef<HTMLDivElement>(null);
  const [forwardHistoryOpen, setForwardHistoryOpen] = React.useState(false);
  const forwardButtonRef = React.useRef<HTMLButtonElement>(null);
  const forwardPopoverRef = React.useRef<HTMLDivElement>(null);
  const [appIconPressed, setAppIconPressed] = React.useState(false);

  // Generate unique IDs for ARIA associations
  const idPrefix = useId();
  const popoverIds = {
    view: `${idPrefix}-view-menu`,
    create: `${idPrefix}-create-menu`,
    sort: `${idPrefix}-sort-menu`,
    filter: `${idPrefix}-filter-menu`,
    more: `${idPrefix}-more-menu`,
    backHistory: `${idPrefix}-back-history`,
    forwardHistory: `${idPrefix}-forward-history`,
  };

  // Show the full active directory path in the TopBar

  React.useEffect(() => {
    if (!appIconPressed || typeof window === 'undefined') return;
    const handlePointerRelease = () => setAppIconPressed(false);
    window.addEventListener('pointerup', handlePointerRelease);
    window.addEventListener('pointercancel', handlePointerRelease);
    return () => {
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, [appIconPressed]);

  // Close popover on outside click
  React.useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = buttonRef.current;
      const pop = popoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setPopoverOpen(false);
      }
    };
    // Use mousedown for snappy close, but ignore clicks inside popover
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  // Close More popover on outside click
  React.useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = moreButtonRef.current;
      const pop = morePopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moreOpen]);

  // Close Sort popover on outside click
  React.useEffect(() => {
    if (!sortOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = sortButtonRef.current;
      const pop = sortPopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setSortOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sortOpen]);

  // Close Filter popover on outside click
  React.useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = filterButtonRef.current;
      const pop = filterPopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  // Close Create popover on outside click
  React.useEffect(() => {
    if (!createOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = createButtonRef.current;
      const pop = createPopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setCreateOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [createOpen]);

  // Close Back history popover on outside click
  React.useEffect(() => {
    if (!backHistoryOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = backButtonRef.current;
      const pop = backPopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setBackHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [backHistoryOpen]);

  // Close Forward history popover on outside click
  React.useEffect(() => {
    if (!forwardHistoryOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const btn = forwardButtonRef.current;
      const pop = forwardPopoverRef.current;
      if (!btn || (!btn.contains(target) && (!pop || !pop.contains(target)))) {
        setForwardHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [forwardHistoryOpen]);

  const viewModes: { key: ViewMode; icon: IconName; label: string }[] = [
    { key: 'list', icon: 'view-list', label: 'List' },
    { key: 'column', icon: 'view-col', label: 'Column' },
    { key: 'grid', icon: 'grid', label: 'Grid' },
  ];

  // Refresh current view after a filesystem change
  const refreshAfterFsChange = React.useCallback(async () => {
    try {
      if (viewMode === 'column') {
        // Nudge column view to re-fetch by updating pathStack reference
        setPathStack([...(pathStack || [])]);
      } else {
        const result = await invoke<FileEntry[]>('list_files', {
          path: currentPath,
          calc_dir_size: false,
        });
        setFiles(
          Array.isArray(result)
            ? result.map((e) => ({
                ...e,
                name: e.name ?? (e.path.split(/[/\\]/).pop() || e.path),
              }))
            : []
        );
      }
    } catch (e) {
      reportError('Refresh failed', e, { toast: showToast, warning: true });
    }
  }, [currentPath, setFiles, viewMode, setPathStack, pathStack, showToast]);

  const handleCreateFolder = async () => {
    // Start a draft new folder inline; defer actual fs mkdir until name confirm
    try {
      const id = `draft:${Date.now()}`;
      useFileStore.getState().setDraftNew({ id, parentPath: currentPath, name: 'New Folder' });
      useFileStore.getState().setEditingId(id);
    } catch (e) {
      reportError('Create folder failed', e, { toast: showToast });
    }
    setCreateOpen(false);
  };
  const handleCreateNote = async () => {
    try {
      await createNoteIn(currentPath);
    } catch (e) {
      reportError('Create note failed', e, { toast: showToast });
    }
    setCreateOpen(false);
    await refreshAfterFsChange();
  };
  const handleCreateWebsite = async () => {
    try {
      const url = window.prompt('Enter URL for the website link', 'https://');
      if (!url) {
        setCreateOpen(false);
        return;
      }
      await createWebsiteLinkIn(currentPath, url);
    } catch (e) {
      reportError('Create website link failed', e, { toast: showToast });
    }
    setCreateOpen(false);
    await refreshAfterFsChange();
  };

  return (
    <div className={styles.topBar}>
      {/* App icon */}
      <img
        src={appIconPressed ? '/icon-face-closed.png' : '/icon-face.png'}
        alt="explorie"
        className={styles.appIcon}
        onPointerDown={() => setAppIconPressed(true)}
        onPointerUp={() => setAppIconPressed(false)}
      />
      {/* Back button with history dropdown */}
      <div className={styles.controlsContainer}>
        <button
          ref={backButtonRef}
          className={styles.upButton}
          title="Back (Alt+Left) - Right-click for history"
          aria-label="Go back"
          aria-keyshortcuts="Alt+ArrowLeft"
          aria-expanded={backHistoryOpen}
          aria-controls={backHistory.length > 0 ? popoverIds.backHistory : undefined}
          onClick={onBack}
          onContextMenu={(e) => {
            e.preventDefault();
            if (backHistory.length > 0) {
              setBackHistoryOpen((v) => !v);
            }
          }}
          disabled={!canGoBack}
        >
          <Icon name="chevron-left" />
        </button>
        {backHistoryOpen && backHistory.length > 0 && (
          <div
            className={styles.historyPopover}
            ref={backPopoverRef}
            id={popoverIds.backHistory}
            role="menu"
            aria-label="Navigation history"
          >
            {/* Show most recent first (reverse order) */}
            {[...backHistory]
              .reverse()
              .slice(0, 10)
              .map((path, idx) => {
                const label = basename(path);
                return (
                  <button
                    key={`back-${path}`}
                    className={styles.popoverItem}
                    role="menuitem"
                    onClick={() => {
                      onBackHistorySelect?.(idx);
                      setBackHistoryOpen(false);
                    }}
                    title={path}
                    aria-label={`Go back to ${label}`}
                  >
                    <span className={styles.popoverIcon}>
                      <Icon name="folder" />
                    </span>
                    <span className={styles.historyLabel}>{label}</span>
                  </button>
                );
              })}
          </div>
        )}
      </div>
      {/* Forward button with history dropdown */}
      <div className={styles.controlsContainer}>
        <button
          ref={forwardButtonRef}
          className={styles.upButton}
          title="Forward (Alt+Right) - Right-click for history"
          aria-label="Go forward"
          aria-keyshortcuts="Alt+ArrowRight"
          aria-expanded={forwardHistoryOpen}
          aria-controls={forwardHistory.length > 0 ? popoverIds.forwardHistory : undefined}
          onClick={onForward}
          onContextMenu={(e) => {
            e.preventDefault();
            if (forwardHistory.length > 0) {
              setForwardHistoryOpen((v) => !v);
            }
          }}
          disabled={!canGoForward}
        >
          <Icon name="chevron-right" />
        </button>
        {forwardHistoryOpen && forwardHistory.length > 0 && (
          <div
            className={styles.historyPopover}
            ref={forwardPopoverRef}
            id={popoverIds.forwardHistory}
            role="menu"
            aria-label="Forward history"
          >
            {forwardHistory.slice(0, 10).map((path, idx) => {
              const label = basename(path);
              return (
                <button
                  key={`forward-${path}`}
                  className={styles.popoverItem}
                  role="menuitem"
                  onClick={() => {
                    onForwardHistorySelect?.(idx);
                    setForwardHistoryOpen(false);
                  }}
                  title={path}
                  aria-label={`Go forward to ${label}`}
                >
                  <span className={styles.popoverIcon}>
                    <Icon name="folder" />
                  </span>
                  <span className={styles.historyLabel}>{label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {/* Up arrow */}
      <button
        className={styles.upButton}
        title="Up"
        aria-label="Go to parent folder"
        onClick={onUp}
        disabled={
          currentPath === '' || currentPath === '/' || !!currentPath.match(/^([A-Za-z]:)?[\\/]?$/)
        }
      >
        <Icon name="arrow-up" />
      </button>
      {/* Breadcrumb navigation */}
      {onNavigate ? (
        <Breadcrumbs path={currentPath} onNavigate={onNavigate} />
      ) : (
        <div className={styles.folderName}>{currentPath}</div>
      )}
      {/* Spacer */}
      <div className={styles.spacer} />

      {/* Create dropdown */}
      <div className={styles.controlsContainer}>
        <button
          ref={createButtonRef}
          title="Create"
          aria-label="Create new item"
          aria-expanded={createOpen}
          aria-haspopup="menu"
          aria-controls={popoverIds.create}
          className={`${styles.controlButton} ${createOpen ? styles.controlButtonActive : ''}`}
          onClick={() => setCreateOpen((v) => !v)}
        >
          <Icon name="plus" />
        </button>
        {createOpen && (
          <div
            className={styles.popover}
            ref={createPopoverRef}
            id={popoverIds.create}
            role="menu"
            aria-label="Create options"
          >
            <button className={styles.popoverItem} role="menuitem" onClick={handleCreateFolder}>
              <span className={styles.popoverIcon}>
                <Icon name="folder" />
              </span>
              <span>New Folder</span>
            </button>
            <button className={styles.popoverItem} role="menuitem" onClick={handleCreateNote}>
              <span className={styles.popoverIcon}>
                <Icon name="file-text" />
              </span>
              <span>New Note</span>
            </button>
            <button className={styles.popoverItem} role="menuitem" onClick={handleCreateWebsite}>
              <span className={styles.popoverIcon}>
                <Icon name="link" />
              </span>
              <span>New Website Link</span>
            </button>
          </div>
        )}
      </div>

      {/* Undo/Redo buttons */}
      <UndoRedoButtons />

      {/* Search bar */}
      <div className={styles.searchContainer} role="search">
        <input
          type="text"
          placeholder="Search"
          aria-label="Search files and folders"
          className={styles.searchInput}
          value={localSearchQuery}
          onChange={handleSearchChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleSearchClear();
          }}
        />
        <span className={styles.searchIcon} aria-hidden="true">
          <Icon name="search" />
        </span>
        {localSearchQuery.trim() && (
          <>
            <button
              className={styles.searchClearButton}
              onClick={handleSearchClear}
              title="Clear search"
              aria-label="Clear search"
            >
              <Icon name="x" />
            </button>
            <button
              className={styles.searchSaveButton}
              onClick={handleSaveSearch}
              title="Save as Smart Folder"
              aria-label="Save search as Smart Folder"
            >
              <Icon name="star" />
            </button>
          </>
        )}
      </div>

      {/* View/Other controls */}
      <div
        className={styles.controlsContainer}
        role="toolbar"
        aria-label="View and display options"
      >
        <button
          ref={buttonRef}
          title="Change View"
          aria-label="Change view mode"
          aria-expanded={popoverOpen}
          aria-haspopup="menu"
          aria-controls={popoverIds.view}
          className={`${styles.controlButton} ${popoverOpen ? styles.controlButtonActive : ''}`}
          onClick={() => setPopoverOpen((v) => !v)}
        >
          <Icon name={viewModes.find((v) => v.key === viewMode)?.icon || 'grid'} />
        </button>
        {popoverOpen && (
          <div
            className={styles.popover}
            ref={popoverRef}
            id={popoverIds.view}
            role="menu"
            aria-label="View options"
          >
            {viewModes.map((mode) => (
              <button
                key={mode.key}
                role="menuitemradio"
                aria-checked={viewMode === mode.key}
                className={`${styles.popoverItem} ${viewMode === mode.key ? styles.popoverItemActive : ''}`}
                onClick={() => {
                  setViewModeStore(mode.key as ViewMode);
                  setPopoverOpen(false);
                }}
              >
                <span className={styles.popoverIcon}>
                  <Icon name={mode.icon} />
                </span>
                <span>{mode.label}</span>
              </button>
            ))}
            {/* Divider */}
            <div className={styles.popoverDivider} role="separator" />
            {/* Hidden files toggle */}
            <button
              role="menuitemcheckbox"
              aria-checked={showHidden}
              className={`${styles.popoverItem} ${showHidden ? styles.popoverItemActive : ''}`}
              onClick={() => setShowHidden(!showHidden)}
            >
              <span className={styles.popoverIcon}>
                <Icon name={showHidden ? 'eye' : 'eye-off'} />
              </span>
              <span>{showHidden ? 'Hide Hidden Files' : 'Show Hidden Files'}</span>
            </button>
            {/* Thumbnail size slider (only in Grid view) */}
            {viewMode === 'grid' && (
              <>
                <div className={styles.popoverDivider} role="separator" />
                <div className={styles.popoverLabel} id={`${idPrefix}-thumb-label`}>
                  Thumbnail Size
                </div>
                <div className={styles.popoverSlider}>
                  <ThumbnailSizeSlider />
                </div>
              </>
            )}
          </div>
        )}
        {/* Sort functionality */}
        <button
          ref={sortButtonRef}
          title="Sort"
          aria-label="Sort options"
          aria-expanded={sortOpen}
          aria-haspopup="menu"
          aria-controls={popoverIds.sort}
          className={`${styles.controlButton} ${sortOpen ? styles.controlButtonActive : ''}`}
          onClick={() => setSortOpen((v) => !v)}
        >
          <Icon name="sort" />
        </button>
        {sortOpen && (
          <div
            className={styles.popover}
            ref={sortPopoverRef}
            id={popoverIds.sort}
            role="menu"
            aria-label="Sort options"
          >
            {(
              [
                { key: 'name', label: 'Name' },
                { key: 'size', label: 'Size' },
                { key: 'modified', label: 'Modified' },
              ] as { key: SortKey; label: string }[]
            ).map((opt) => (
              <button
                key={opt.key}
                role="menuitemradio"
                aria-checked={sortKey === opt.key}
                className={`${styles.popoverItem} ${sortKey === opt.key ? styles.popoverItemActive : ''}`}
                onClick={() => {
                  // Toggle direction if same key, otherwise set to asc
                  setSort(opt.key);
                  setSortOpen(false);
                }}
              >
                <span className={styles.popoverIcon}>
                  <Icon
                    name={
                      sortKey === opt.key
                        ? sortDir === 'asc'
                          ? 'arrow-up'
                          : 'arrow-down'
                        : 'circle'
                    }
                  />
                </span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        )}
        {/* Filter functionality */}
        <button
          ref={filterButtonRef}
          title="Filter"
          aria-label="Filter options"
          aria-expanded={filterOpen}
          aria-haspopup="menu"
          aria-controls={popoverIds.filter}
          className={`${styles.controlButton} ${filterOpen ? styles.controlButtonActive : ''}`}
          onClick={() => setFilterOpen((v) => !v)}
        >
          <Icon name="shield" />
        </button>
        {filterOpen && (
          <div
            className={styles.popover}
            ref={filterPopoverRef}
            id={popoverIds.filter}
            role="menu"
            aria-label="Filter options"
          >
            {(
              [
                { key: 'all', label: 'All', icon: 'circle' },
                { key: 'folders', label: 'Folders', icon: 'folder' },
                { key: 'files', label: 'Files', icon: 'file' },
              ] as { key: 'all' | 'folders' | 'files'; label: string; icon: IconName }[]
            ).map((opt) => (
              <button
                key={opt.key}
                role="menuitemradio"
                aria-checked={filterMode === opt.key}
                className={`${styles.popoverItem} ${filterMode === opt.key ? styles.popoverItemActive : ''}`}
                onClick={() => {
                  setFilterMode(opt.key);
                  setFilterOpen(false);
                }}
              >
                <span className={styles.popoverIcon}>
                  <Icon name={opt.icon} />
                </span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        )}
        {/* Theme toggle */}
        <button
          title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-pressed={theme === 'dark'}
          className={styles.controlButton}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Icon name="sun" /> : <Icon name="moon" />}
        </button>
        {/* More actions popover */}
        <button
          ref={moreButtonRef}
          title="More"
          aria-label="More options"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-controls={popoverIds.more}
          className={`${styles.controlButton} ${moreOpen ? styles.controlButtonActive : ''}`}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <Icon name="more-vertical" />
        </button>
        {moreOpen && (
          <div
            className={styles.popover}
            ref={morePopoverRef}
            id={popoverIds.more}
            role="menu"
            aria-label="More options"
          >
            <button
              className={styles.popoverItem}
              role="menuitemcheckbox"
              aria-checked={showFolderSizes}
              onClick={() => {
                setShowFolderSizes(!showFolderSizes);
                setMoreOpen(false);
              }}
            >
              <span className={styles.popoverIcon}>
                <Icon name={showFolderSizes ? 'check' : 'circle'} />
              </span>
              <span>{showFolderSizes ? 'Hide Folder Sizes' : 'Show Folder Sizes'}</span>
            </button>
            <button
              className={styles.popoverItem}
              role="menuitemcheckbox"
              aria-checked={enableDnDLargeLists}
              onClick={() => {
                setEnableDnDLargeLists(!enableDnDLargeLists);
                setMoreOpen(false);
              }}
              title="Enable drag & drop even on very large lists (may affect performance)"
            >
              <span className={styles.popoverIcon}>
                <Icon name={enableDnDLargeLists ? 'check' : 'circle'} />
              </span>
              <span>Allow DnD on Large Lists</span>
            </button>
            {isDevBuild && (
              <button
                className={styles.popoverItem}
                role="menuitemcheckbox"
                aria-checked={devMockEntries}
                onClick={() => {
                  setDevMockEntries(!devMockEntries);
                  setMoreOpen(false);
                }}
                title="Dev only: toggle 10k mock entries in the current folder"
              >
                <span className={styles.popoverIcon}>
                  <Icon name={devMockEntries ? 'check' : 'circle'} />
                </span>
                <span>Dev: Mock 10k Entries</span>
              </button>
            )}
            <button
              className={styles.popoverItem}
              role="menuitemcheckbox"
              aria-checked={showPreviewPanel}
              onClick={() => {
                setShowPreviewPanel(!showPreviewPanel);
                setMoreOpen(false);
              }}
            >
              <span className={styles.popoverIcon}>
                <Icon name={showPreviewPanel ? 'eye-off' : 'eye'} />
              </span>
              <span>{showPreviewPanel ? 'Hide Preview Panel' : 'Show Preview Panel'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Separate component for undo/redo buttons to avoid re-rendering TopBar on every undo/redo state change
function UndoRedoButtons() {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const undoAction = useUndoRedoStore((s) => s.undo);
  const redoAction = useUndoRedoStore((s) => s.redo);
  const lastUndoOp = useUndoRedoStore((s) => s.undoStack[s.undoStack.length - 1]);
  const lastRedoOp = useUndoRedoStore((s) => s.redoStack[s.redoStack.length - 1]);

  return (
    <div className={styles.controlsContainer} role="group" aria-label="Undo and redo">
      <button
        className={styles.controlButton}
        title={
          canUndo ? `Undo: ${lastUndoOp?.description || 'last action'} (Ctrl+Z)` : 'Undo (Ctrl+Z)'
        }
        aria-label={canUndo ? `Undo ${lastUndoOp?.description || 'last action'}` : 'Undo'}
        aria-keyshortcuts="Control+Z"
        onClick={() => canUndo && undoAction()}
        disabled={!canUndo}
      >
        <Icon name="undo" />
      </button>
      <button
        className={styles.controlButton}
        title={
          canRedo ? `Redo: ${lastRedoOp?.description || 'last action'} (Ctrl+Y)` : 'Redo (Ctrl+Y)'
        }
        aria-label={canRedo ? `Redo ${lastRedoOp?.description || 'last action'}` : 'Redo'}
        aria-keyshortcuts="Control+Y"
        onClick={() => canRedo && redoAction()}
        disabled={!canRedo}
      >
        <Icon name="redo" />
      </button>
    </div>
  );
}
