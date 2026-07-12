import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useFileStore } from './store';
import { ListView } from './components/ListView';
import { ColumnView } from './components/ColumnView';
import { GridView } from './components/GridView';
import { FilePreviewer } from './components/FilePreviewer';
import { QuickLookModal } from './components/QuickLookModal';
import { StatusBar } from './components/StatusBar';
import { GoToFolderDialog } from './components/GoToFolderDialog';
import { getCachedDirSize, mergeDirectorySizes, setCachedDirSize } from './dirSizeCache';
import styles from './App.module.css'; // Import CSS Module
import { useShallow } from 'zustand/shallow';
import { useInitialPath } from './hooks/useInitialPath';
import { ToastProvider, useToast } from './components/Toast';
import { useUndoRedoStore, useCanUndo, useCanRedo } from './undoRedoStore';
import { OperationProgress } from './components/OperationProgress';
import { getParentPath as getParentPathUtil, normalizePath } from './utils/path';
import { runSmartFolderSearch } from './utils/smartFolderSearch';
import { sortFiles, type SortDir, type SortKey } from './components/FileTable';
import { useTabs } from './hooks/useTabs';
import { useWorkspaceManager } from './hooks/useWorkspaceManager';
import { useFileDragAndDrop } from './hooks/useFileDragAndDrop';
import { useNavigationHandlers } from './hooks/useNavigationHandlers';
import { useAppCommands } from './hooks/useAppCommands';
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts';
import { calculatePaneLayout, useAppLayoutPersistence } from './hooks/useAppLayoutPersistence';
import { useQuickLookController } from './hooks/useQuickLookController';
import { formatErrorMessage } from './utils/errorMessages';
import { DragOverlay } from './components/DragOverlay';
import { deleteWithUndo } from './utils/fileOperations';
import { chooseFolder } from './utils/folderPicker';

const MAX_CONCURRENT_DIR_SIZE_REQUESTS = 4;
const isDevBuild = import.meta.env.DEV;
const LazySecureDeleteDialog = React.lazy(() =>
  import('./components/SecureDeleteDialog').then((module) => ({
    default: module.SecureDeleteDialog,
  }))
);
type CssVariableStyle<K extends string> = React.CSSProperties & Record<K, string>;

function createDevMockEntries(basePath: string): FileEntry[] {
  const normalizedBase = basePath.replace(/\\$/, '') || '/';
  return Array.from({ length: 10000 }).map((_, i) => ({
    id: `mock-${i}`,
    path: `${normalizedBase}/mockfile-${i}${i % 10 === 0 ? '' : '.txt'}`,
    name: `mockfile-${i}${i % 10 === 0 ? '' : '.txt'}`,
    size: i % 10 === 0 ? 0 : Math.floor(Math.random() * 5_000_000),
    modified: new Date(Date.now() - i * 1000).toISOString(),
    hidden: false,
    is_dir: i % 10 === 0,
    custom: i % 15 === 0 ? { status: i % 30 === 0 ? 'Done' : 'In Progress' } : {},
  }));
}
// Extend window type for explorie globals
interface ExplorieWindow extends Window {
  __explorieInflightSizes?: Map<string, Promise<number>>;
}

async function fetchDirSizesConcurrent(
  entries: FileEntry[],
  onSizes: (sizes: ReadonlyMap<string, number>) => void,
  shouldCancel: () => boolean
): Promise<void> {
  if (typeof window === 'undefined') return;
  const pending = entries.filter((entry) => entry.is_dir);
  if (pending.length === 0) return;

  const queue = [...pending];
  const workerCount = Math.min(MAX_CONCURRENT_DIR_SIZE_REQUESTS, queue.length);
  if (workerCount === 0) return;

  const w = window as ExplorieWindow;
  if (!w.__explorieInflightSizes) {
    w.__explorieInflightSizes = new Map<string, Promise<number>>();
  }
  const inflight = w.__explorieInflightSizes;
  const completed = new Map<string, number>();
  let flushTimer: number | null = null;

  const flush = () => {
    flushTimer = null;
    if (shouldCancel() || completed.size === 0) {
      completed.clear();
      return;
    }
    onSizes(new Map(completed));
    completed.clear();
  };

  const queueSize = (entry: FileEntry, size: number) => {
    completed.set(entry.id, size);
    if (flushTimer === null) flushTimer = window.setTimeout(flush, 50);
  };

  const runWorker = async () => {
    while (!shouldCancel() && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        return;
      }

      if (shouldCancel()) return;

      const cached = getCachedDirSize(entry.path);
      if (cached !== undefined) {
        if (shouldCancel()) return;
        queueSize(entry, cached);
        continue;
      }

      const key = entry.path;
      let task = inflight.get(key);
      if (!task) {
        task = invoke<number>('get_dir_size', { path: key });
        inflight.set(key, task);
      }

      try {
        const size = await task;
        inflight.delete(key);
        setCachedDirSize(key, size);
        if (shouldCancel()) return;
        queueSize(entry, size);
      } catch {
        inflight.delete(key);
        if (shouldCancel()) return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flush();
}

import { Sidebar } from './components/Sidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { TopBar } from './components/TopBar';
import { getTitleBarState, TitleBar } from './components/TitleBar';
import { TabsBar } from './components/TabsBar';
import { ErrorBoundary, InlineErrorBoundary } from './components/ErrorBoundary';
import { CommandPalette } from './components/CommandPalette';
import { KeyboardShortcutsOverlay } from './components/KeyboardShortcutsOverlay';
import { useThumbnailSizeShortcuts } from './components/ThumbnailSizeSlider';
import { SkipLinks } from './components/SkipLinks';
import { WorkspaceManager } from './components/WorkspaceManager';
import { ConflictResolutionDialog } from './components/ConflictResolutionDialog';
import { useConflictResolutionStore } from './conflictResolutionStore';
import { useCrashRecovery } from './hooks/useCrashRecovery';
import { RecoveryBanner } from './components/RecoveryBanner';
import { useKeyboardClipboardManager } from './hooks/useKeyboardClipboard';
import { DebugPanel } from './components/DebugPanel';
import { TextInputDialog } from './components/TextInputDialog';
import { FolderLoadErrorState, StartupLocationState } from './components/LocationRecoveryState';
import type { WorkspaceTab, FileEntry } from './store';

// Main App with ToastProvider wrapper
export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
// Inner App content that can use toast hook
function AppContent() {
  const tauri = isTauri();
  const { showTitleBar, showWindowControls } = getTitleBarState(
    document.documentElement.dataset.platform,
    tauri
  );

  // Toast for notifications
  const { show: showToast } = useToast();

  // Undo/Redo state
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const undoAction = useUndoRedoStore((s) => s.undo);
  const redoAction = useUndoRedoStore((s) => s.redo);
  // Batch state selectors to reduce re-renders
  const {
    files,
    loading,
    error,
    viewMode,
    theme,
    pathStack,
    filterMode,
    searchQuery,
    showHidden,
    showPreviewPanel,
    showStatusBar,
    showFolderSizes,
    sortKey,
    sortDir,
  } = useFileStore(
    useShallow((s) => ({
      files: s.files,
      loading: s.loading,
      error: s.error,
      viewMode: s.viewMode,
      theme: s.theme,
      pathStack: s.pathStack,
      filterMode: s.filterMode,
      searchQuery: s.searchQuery,
      showHidden: s.showHidden,
      showPreviewPanel: s.showPreviewPanel,
      showStatusBar: s.showStatusBar,
      showFolderSizes: s.showFolderSizes,
      sortKey: s.sortKey,
      sortDir: s.sortDir,
    }))
  );

  // Action selectors (stable references, don't need shallow comparison)
  const setFiles = useFileStore((s) => s.setFiles);
  const setLoading = useFileStore((s) => s.setLoading);
  const setError = useFileStore((s) => s.setError);
  const setViewMode = useFileStore((s) => s.setViewMode);
  const setTheme = useFileStore((s) => s.setTheme);
  const setPathStack = useFileStore((s) => s.setPathStack);
  const setShowHidden = useFileStore((s) => s.setShowHidden);
  const setShowPreviewPanel = useFileStore((s) => s.setShowPreviewPanel);
  const setShowStatusBar = useFileStore((s) => s.setShowStatusBar);
  const addFavorite = useFileStore((s) => s.addFavorite);
  const selectedPaths = useFileStore((s) => s.selectedPaths);
  const selectionCursorPath = useFileStore((s) => s.selectionCursorPath);
  const setSelectedPaths = useFileStore((s) => s.setSelectedPaths);
  const setSelectionCursorPath = useFileStore((s) => s.setSelectionCursorPath);
  const activeSmartFolderId = useFileStore((s) => s.activeSmartFolderId);
  const smartFolders = useFileStore((s) => s.smartFolders);
  const setActiveSmartFolderId = useFileStore((s) => s.setActiveSmartFolderId);
  const clipboard = useFileStore((s) => s.clipboard);
  const setClipboard = useFileStore((s) => s.setClipboard);

  const viewModeRef = useRef(viewMode);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  const activeSmartFolder = activeSmartFolderId ? smartFolders[activeSmartFolderId] : null;
  const shouldUseDevMockEntries = isDevBuild && !tauri;

  useEffect(() => {
    if (activeSmartFolderId && !activeSmartFolder) {
      setActiveSmartFolderId(null);
    }
  }, [activeSmartFolderId, activeSmartFolder, setActiveSmartFolderId]);

  useEffect(() => {
    if (viewMode === 'column' && activeSmartFolderId) {
      setActiveSmartFolderId(null);
    }
  }, [viewMode, activeSmartFolderId, setActiveSmartFolderId]);

  const clearActiveSmartFolder = useCallback(() => {
    if (useFileStore.getState().activeSmartFolderId) {
      setActiveSmartFolderId(null);
    }
  }, [setActiveSmartFolderId]);

  const {
    sidebarWidth,
    setSidebarWidth,
    previewWidth,
    setPreviewWidth,
    handleSidebarResizeStart,
    handlePreviewResizeStart,
  } = useAppLayoutPersistence(styles.sidebarResizing);
  const appBodyRef = useRef<HTMLDivElement>(null);
  const [appBodyWidth, setAppBodyWidth] = useState(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth
  );

  useEffect(() => {
    const element = appBodyRef.current;
    if (!element) return;

    const updateWidth = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setAppBodyWidth(width);
    };
    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Current path for active tab (persisted via hook)
  const {
    currentPath,
    setCurrentPath,
    initializing: pathInitializing,
    initializationError,
    retryInitialization,
  } = useInitialPath();
  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // Selected file for preview
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const previewPanelVisible = showPreviewPanel && !!selectedFile;
  const paneLayout = useMemo(
    () => calculatePaneLayout(appBodyWidth, sidebarWidth, previewWidth, previewPanelVisible),
    [appBodyWidth, previewPanelVisible, previewWidth, sidebarWidth]
  );

  useEffect(() => {
    setSelectedFile(null);
  }, [currentPath, activeSmartFolderId]);

  const {
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    addTab,
    closeTab,
    activateTab,
    reorderTabs,
  } = useTabs({
    currentPath,
    setCurrentPath,
    clearActiveSmartFolder,
    setSelectedFile,
  });

  const { handleLoadWorkspace, getWindowState, getSidebarState } = useWorkspaceManager({
    currentPath,
    setTabs,
    setActiveTabId,
    setCurrentPath,
    setSelectedFile,
    setSidebarWidth,
    sidebarWidth,
    clearActiveSmartFolder,
  });

  // Crash recovery - restore previous session if it ended unexpectedly
  const { recoveryAvailable, recoveryInfo, acceptRecovery, dismissRecovery } = useCrashRecovery({
    getTabs: () => tabsRef.current,
    getActiveTabId: () => activeTabIdRef.current,
    getCurrentPath: () => currentPathRef.current,
    onRestoreTabs: (restoredTabs, restoredActiveId) => {
      setTabs(restoredTabs);
      setActiveTabId(restoredActiveId);
      const activeTab = restoredTabs.find((t) => t.id === restoredActiveId);
      if (activeTab?.path) {
        setCurrentPath(activeTab.path);
      }
    },
    onNavigate: (path) => {
      clearActiveSmartFolder();
      setCurrentPath(path);
    },
  });

  const {
    canGoBack,
    canGoForward,
    backHistory,
    forwardHistory,
    handleGoBack,
    handleGoForward,
    handleGoToBackIndex,
    handleGoToForwardIndex,
    handleClearHistoryFromPalette,
  } = useNavigationHandlers({
    activeTabId,
    currentPath,
    setCurrentPath,
    setPathStack,
    clearActiveSmartFolder,
    viewModeRef,
    buildPathStackFromPath,
    showToast,
  });

  // Map of path -> files for column/hybrid view
  const [columnFiles, setColumnFiles] = useState<{ [path: string]: FileEntry[] }>({});

  useEffect(() => {
    const visible = viewMode === 'column' ? Object.values(columnFiles).flat() : files;
    const selected = new Set(selectedPaths);
    const next =
      visible.find((file) => file.path === selectionCursorPath && selected.has(file.path)) ??
      visible.find((file) => selected.has(file.path)) ??
      null;
    setSelectedFile(next);
  }, [columnFiles, files, selectedPaths, selectionCursorPath, viewMode]);

  const quickLook = useQuickLookController({
    files,
    columnFiles,
    pathStack,
    currentPath,
    viewMode,
    filterMode,
    searchQuery,
    showHidden,
    sortKey: sortKey as SortKey,
    sortDir: sortDir as SortDir,
    selectedFile,
    setSelectedFile,
  });

  // Column view state can be extended here if needed

  // Settings panel visibility
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Go to Folder dialog visibility
  const [goToFolderOpen, setGoToFolderOpen] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderPickerError, setFolderPickerError] = useState<string | null>(null);

  // Command Palette visibility
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Keyboard Shortcuts Overlay visibility
  const [shortcutsOverlayOpen, setShortcutsOverlayOpen] = useState(false);

  // Workspace Manager visibility
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [workspaceNameDialogOpen, setWorkspaceNameDialogOpen] = useState(false);

  // Debug Panel visibility
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [shortcutDeleteFiles, setShortcutDeleteFiles] = useState<FileEntry[]>([]);
  const typeSelectRef = useRef({ value: '', at: 0 });

  // Thumbnail size shortcuts
  const { increase: increaseThumbnailSize, decrease: decreaseThumbnailSize } =
    useThumbnailSizeShortcuts();

  // --- Recents management (lifted from Sidebar) ---
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie.recents');
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((p: unknown) => typeof p === 'string') : [];
      }
    } catch {}
    return [];
  });

  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie.recents', JSON.stringify(recents));
    } catch {}
  }, [recents]);

  // Update recents when navigation happens anywhere (not just Sidebar)
  useEffect(() => {
    if (!currentPath) return;
    const np = normalizePath(currentPath);
    setRecents((prev) => {
      const next = [np, ...prev.filter((p) => p !== np)];
      return next.slice(0, 5);
    });
  }, [currentPath]);

  // --- Path helpers for Finder-like column view ---
  function buildPathStackFromPath(p: string): string[] {
    const np = normalizePath(p);
    // Windows drive-rooted path (e.g., C:/Users/Ada/Docs)
    const driveRootMatch = np.match(/^([A-Za-z]:)\/(.*)$/);
    if (driveRootMatch) {
      const drive = `${driveRootMatch[1]}/`;
      const rest = driveRootMatch[2];
      if (!rest) return [drive];
      const parts = rest.split('/').filter(Boolean);
      const stack: string[] = [drive];
      let acc = drive.replace(/\/$/, '');
      for (const part of parts) {
        acc = `${acc}/${part}`;
        stack.push(acc);
      }
      return stack;
    }
    // Unix-like root (/a/b/c)
    if (np.startsWith('/')) {
      const parts = np.split('/').filter(Boolean);
      const stack: string[] = ['/'];
      if (parts.length === 0) return stack;
      let acc = '';
      for (const part of parts) {
        acc = `${acc}/${part}`;
        stack.push(acc);
      }
      return stack;
    }
    // Relative path fallback
    const parts = np.split('/').filter(Boolean);
    const stack: string[] = parts.length ? [parts[0]] : [np];
    let acc = parts[0] || np;
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc}/${parts[i]}`;
      stack.push(acc);
    }
    return stack;
  }

  // Theme is now handled globally by index.css and CSS variables
  // The ThemeToggle component might still be used to toggle a class on the body if needed,
  // but App.tsx doesn't need to manage the CSS file link anymore.

  // Theme management: dark/light without external CSS
  useEffect(() => {
    const stored =
      typeof window !== 'undefined' ? window.localStorage.getItem('explorie:theme') : null;
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      setTheme(stored);
    } else if (stored === 'dracula' || stored === 'default') {
      setTheme('dark');
      try {
        window.localStorage.setItem('explorie:theme', 'dark');
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // High contrast mode
  const highContrast = useFileStore((s) => s.highContrast);

  // Theme + Appearance effects
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const effective = theme === 'system' ? (mql.matches ? 'dark' : 'light') : theme;
      body.classList.remove('theme-light', 'theme-dark', 'high-contrast');
      body.classList.add(effective === 'light' ? 'theme-light' : 'theme-dark');
      if (highContrast) {
        body.classList.add('high-contrast');
      }
    };
    applyTheme();
    const onChange = () => {
      if (theme === 'system') applyTheme();
    };
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [theme, highContrast]);

  // Accent color effect
  const accent = useFileStore((s) => s.accent);
  const accentCustom = useFileStore((s) => s.accentCustom);
  useEffect(() => {
    const root = document.documentElement;
    const map: Record<string, string> = {
      blue: '#7cc7ff',
      green: '#9ad1a8',
      purple: '#b39ddb',
      orange: '#ffb86b',
      pink: '#ff8aa0',
    };
    const hex = accent === 'custom' ? accentCustom || '#7cc7ff' : map[accent] || '#7cc7ff';
    const clean = hex.startsWith('#') ? hex.slice(1) : hex;
    const r = parseInt(clean.slice(0, 2), 16) || 124;
    const g = parseInt(clean.slice(2, 4), 16) || 199;
    const b = parseInt(clean.slice(4, 6), 16) || 255;
    root.style.setProperty('--accent-primary', `#${clean}`);
    root.style.setProperty('--accent-primary-rgb', `${r}, ${g}, ${b}`);
  }, [accent, accentCustom]);

  // Density + UI scale: compute scaled spacing and font scale
  const density = useFileStore((s) => s.density);
  const uiScale = useFileStore((s) => s.uiScale);
  useEffect(() => {
    const root = document.documentElement;
    const baseXs = 2;
    const baseSm = density === 'compact' ? 3 : 4;
    const baseMd = density === 'compact' ? 6 : 8;
    const baseLg = density === 'compact' ? 9 : 12;
    const baseXl = density === 'compact' ? 12 : 16;
    const base2xl = density === 'compact' ? 18 : 24;
    const xs = Math.round(baseXs * uiScale * 100) / 100;
    const sm = Math.round(baseSm * uiScale * 100) / 100;
    const md = Math.round(baseMd * uiScale * 100) / 100;
    const lg = Math.round(baseLg * uiScale * 100) / 100;
    const xl = Math.round(baseXl * uiScale * 100) / 100;
    const xxl = Math.round(base2xl * uiScale * 100) / 100;
    root.style.setProperty('--padding-xs', `${xs}px`);
    root.style.setProperty('--padding-sm', `${sm}px`);
    root.style.setProperty('--padding-md', `${md}px`);
    root.style.setProperty('--padding-lg', `${lg}px`);
    root.style.setProperty('--padding-xl', `${xl}px`);
    root.style.setProperty('--padding-2xl', `${xxl}px`);
    root.style.setProperty('--ui-scale', String(uiScale));
    root.style.setProperty('--font-scale', String(uiScale));
  }, [density, uiScale]);

  // Font family effect
  const font = useFileStore((s) => s.font);
  const fontCustom = useFileStore((s) => s.fontCustom);
  useEffect(() => {
    const root = document.documentElement;
    let val = 'var(--font-mono)';
    if (font === 'system') val = 'var(--font-sans)';
    else if (font === 'mono') val = 'var(--font-mono)';
    else if (font === 'serif') val = "Georgia, 'Times New Roman', serif";
    else if (font === 'custom') {
      const raw = (fontCustom || '').trim();
      if (raw) {
        // If user provided a full CSS family list, use as-is; otherwise quote and add fallback
        const hasComma = raw.includes(',');
        const needsQuote = /\s/.test(raw) && !raw.includes("'") && !raw.includes('"');
        const fam = needsQuote ? `'${raw}'` : raw;
        val = hasComma ? fam : `${fam}, var(--font-sans)`;
      } else {
        val = 'var(--font-sans)';
      }
    }
    root.style.setProperty('--font-base', val);
  }, [font, fontCustom]);

  // Border radius effect
  const borderRadius = useFileStore((s) => s.borderRadius);
  useEffect(() => {
    const root = document.documentElement;
    const v = `${borderRadius}px`;
    root.style.setProperty('--border-radius-sm', v);
    root.style.setProperty('--border-radius-md', v);
    root.style.setProperty('--border-radius-lg', v);
  }, [borderRadius]);

  // Icon size effect
  const iconSize = useFileStore((s) => s.iconSize);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--icon-size', `${iconSize}px`);
  }, [iconSize]);

  // Reduce motion effect
  const reduceMotion = useFileStore((s) => s.reduceMotion);
  useEffect(() => {
    document.body.classList.toggle('reduceMotion', !!reduceMotion);
  }, [reduceMotion]);

  // List row height + Grid min width
  const listRowHeight = useFileStore((s) => s.listRowHeight);
  const gridMinWidth = useFileStore((s) => s.gridMinWidth);
  useEffect(() => {
    const root = document.documentElement;
    const row = Math.round(listRowHeight * uiScale);
    const grid = Math.round(gridMinWidth * uiScale);
    root.style.setProperty('--row-height', `${row}px`);
    root.style.setProperty('--grid-min-width', `${grid}px`);
  }, [listRowHeight, gridMinWidth, uiScale]);

  // Fetch files for the current path (list/grid views)
  useEffect(() => {
    if (pathInitializing || (!currentPath && !activeSmartFolder)) return;
    if (viewMode === 'list' || viewMode === 'grid') {
      let cancelled = false;
      const fetchFiles = async () => {
        setLoading(true);
        setError(null);
        try {
          let result: FileEntry[];
          if (activeSmartFolder) {
            result = await runSmartFolderSearch(activeSmartFolder.criteria);
          } else if (shouldUseDevMockEntries) {
            result = createDevMockEntries(currentPath);
          } else {
            result = await invoke<FileEntry[]>('list_files', {
              path: currentPath,
              calc_dir_size: false,
            });
          }
          if (cancelled) return;
          setFiles(
            result.map((e) => ({
              ...e,
              name: e.name ?? (e.path.split(/[/\\]/).pop() || e.path),
            }))
          );
          if (showFolderSizes) {
            void fetchDirSizesConcurrent(
              result,
              (sizes) => setFiles((prev) => mergeDirectorySizes(prev, sizes)),
              () => cancelled
            );
          }
        } catch (err: unknown) {
          setError(formatErrorMessage(err));
        } finally {
          setLoading(false);
        }
      };
      fetchFiles();
      return () => {
        cancelled = true;
      };
    }
  }, [
    setFiles,
    setLoading,
    setError,
    viewMode,
    currentPath,
    showFolderSizes,
    pathInitializing,
    activeSmartFolder,
    shouldUseDevMockEntries,
  ]);

  // Track columnFiles in a ref to avoid dependency issues
  const columnFilesRef = useRef(columnFiles);
  columnFilesRef.current = columnFiles;

  // Fetch files for each path in pathStack (column view)
  // Only fetch paths that aren't already loaded to avoid unnecessary reloads
  useEffect(() => {
    if (pathInitializing || !currentPath) return;
    if (viewMode === 'column') {
      let cancelled = false;
      const fetchAll = async () => {
        const currentColumnFiles = columnFilesRef.current;
        // Determine which paths need fetching (not already in columnFiles)
        const pathsToFetch = pathStack.filter((p) => !currentColumnFiles[p]);

        // If no new paths to fetch, just trim columnFiles to current pathStack
        if (pathsToFetch.length === 0) {
          setColumnFiles((prev) => {
            const trimmed: { [path: string]: FileEntry[] } = {};
            for (const p of pathStack) {
              if (prev[p]) trimmed[p] = prev[p];
            }
            return trimmed;
          });
          return;
        }

        setLoading(true);
        setError(null);
        try {
          const newColumnFiles: { [path: string]: FileEntry[] } = {};
          const sizeTasks: Array<() => Promise<void>> = [];

          // Keep existing files for paths still in pathStack
          for (const path of pathStack) {
            if (currentColumnFiles[path]) {
              newColumnFiles[path] = currentColumnFiles[path];
            }
          }

          // Fetch only new paths
          for (const path of pathsToFetch) {
            const result = shouldUseDevMockEntries
              ? createDevMockEntries(path)
              : await invoke<FileEntry[]>('list_files', { path, calc_dir_size: false });
            if (cancelled) return;
            newColumnFiles[path] = result.map((e) => ({
              ...e,
              name: e.name ?? (e.path.split(/[/\\]/).pop() || e.path),
            }));
            if (showFolderSizes) {
              const columnPath = path;
              sizeTasks.push(() =>
                fetchDirSizesConcurrent(
                  result,
                  (sizes) => {
                    setColumnFiles((prev) => ({
                      ...prev,
                      [columnPath]: mergeDirectorySizes(prev[columnPath] || [], sizes),
                    }));
                  },
                  () => cancelled
                )
              );
            }
          }
          if (!cancelled) {
            setColumnFiles(newColumnFiles);
            for (const startTask of sizeTasks) {
              void startTask();
            }
          }
        } catch (err: unknown) {
          setError(formatErrorMessage(err));
        } finally {
          setLoading(false);
        }
      };
      fetchAll();
      return () => {
        cancelled = true;
      };
    }
  }, [
    pathStack,
    setError,
    setLoading,
    viewMode,
    showFolderSizes,
    pathInitializing,
    currentPath,
    shouldUseDevMockEntries,
  ]);

  // Build full ancestor stack for column view (Finder-like)
  useEffect(() => {
    if (pathInitializing || !currentPath) return;
    if (viewMode === 'column') {
      const newStack = buildPathStackFromPath(currentPath);
      const same =
        newStack.length === pathStack.length && newStack.every((v, i) => v === pathStack[i]);
      if (!same) setPathStack(newStack);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, currentPath, pathInitializing]);

  // Persist column path stack while in column view
  useEffect(() => {
    if (viewMode === 'column') {
      try {
        if (typeof window !== 'undefined')
          window.localStorage.setItem('explorie:pathStack', JSON.stringify(pathStack));
      } catch {}
    }
  }, [pathStack, viewMode]);

  // On first mount, if starting in column view, restore last column path stack
  useEffect(() => {
    try {
      if (viewMode === 'column' && typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:pathStack');
        if (raw) {
          const arr = JSON.parse(raw);
          if (
            Array.isArray(arr) &&
            arr.length > 0 &&
            arr.every((s: unknown) => typeof s === 'string')
          ) {
            setPathStack(arr);
            setCurrentPath(arr[arr.length - 1]);
          }
        }
      }
    } catch {}
    // run only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Note: We update currentPath directly in column/hybrid navigation handlers
  // to avoid race conditions between effects.

  // Handler: click folder in column
  const handleColumnFolderClick = useCallback(
    (colIdx: number, entry: FileEntry) => {
      if (entry.is_dir) {
        const newStack = pathStack.slice(0, colIdx + 1);
        newStack.push(entry.path);
        setPathStack(newStack);
        // Keep currentPath aligned with the active (rightmost) column
        setCurrentPath(entry.path);
      }
    },
    [pathStack, setPathStack, setCurrentPath]
  );

  // Handler: click parent column to pop stack
  const handleColumnBack = useCallback(
    (colIdx: number) => {
      if (colIdx < pathStack.length - 1) {
        const newStack = pathStack.slice(0, colIdx + 1);
        setPathStack(newStack);
        setCurrentPath(newStack[newStack.length - 1] || currentPath);
      }
    },
    [pathStack, setPathStack, setCurrentPath, currentPath]
  );

  // Sorting handled within views (no hybrid view)

  // NOTE: ThemeToggle might need adjustment later if we want to support light/dark toggle
  // For now, we assume dark theme is default via index.css

  // Refresh currently visible views (list/grid or column)
  const refreshVisibleViews = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (viewMode === 'list' || viewMode === 'grid') {
        const refreshed = activeSmartFolder
          ? await runSmartFolderSearch(activeSmartFolder.criteria)
          : shouldUseDevMockEntries
            ? createDevMockEntries(currentPath)
            : await invoke<FileEntry[]>('list_files', { path: currentPath, calc_dir_size: false });
        setFiles(
          refreshed.map((e) => ({
            ...e,
            name: e.name ?? (e.path.split(/[/\\]/).pop() || e.path),
          }))
        );
        if (showFolderSizes) {
          void fetchDirSizesConcurrent(
            refreshed,
            (sizes) => setFiles((prev) => mergeDirectorySizes(prev, sizes)),
            () => false
          );
        }
      } else {
        const refreshed: { [path: string]: FileEntry[] } = {};
        for (const path of pathStack) {
          const res = shouldUseDevMockEntries
            ? createDevMockEntries(path)
            : await invoke<FileEntry[]>('list_files', { path, calc_dir_size: false });
          refreshed[path] = res;
          if (showFolderSizes) {
            void fetchDirSizesConcurrent(
              res,
              (sizes) => {
                setColumnFiles((prev) => ({
                  ...prev,
                  [path]: mergeDirectorySizes(prev[path] || [], sizes),
                }));
              },
              () => false
            );
          }
        }
        setColumnFiles(refreshed);
      }
    } catch (refreshError) {
      setError(formatErrorMessage(refreshError));
    } finally {
      setLoading(false);
    }
  }, [
    viewMode,
    currentPath,
    pathStack,
    showFolderSizes,
    setFiles,
    setError,
    setLoading,
    activeSmartFolder,
    shouldUseDevMockEntries,
  ]);

  // Helper: get parent directory of a path (supports Windows + POSIX)
  const getParentPath = useCallback((p: string): string => getParentPathUtil(p), []);
  const handleDragOpenFolder = useCallback(
    (folder: FileEntry) => {
      clearActiveSmartFolder();
      setCurrentPath(folder.path);
      if (viewMode === 'column') setPathStack(buildPathStackFromPath(folder.path));
    },
    [clearActiveSmartFolder, setCurrentPath, setPathStack, viewMode]
  );
  const handleDragOpenPath = useCallback(
    (path: string) => {
      clearActiveSmartFolder();
      setCurrentPath(path);
      if (viewMode === 'column') setPathStack(buildPathStackFromPath(path));
    },
    [clearActiveSmartFolder, setCurrentPath, setPathStack, viewMode]
  );

  const {
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
  } = useFileDragAndDrop({
    files,
    columnFiles,
    viewMode,
    selectedPaths,
    setSelectedPaths,
    refreshVisibleViews,
    getParentPath,
    showToast,
    addFavorite,
    onOpenFolder: handleDragOpenFolder,
  });

  // Keyboard clipboard shortcuts (Ctrl+C, Ctrl+X, Ctrl+V)
  const { getSelectedFilesRef } = useKeyboardClipboardManager({
    currentPath,
    clipboard,
    setClipboard,
    showToast,
    onRefresh: refreshVisibleViews,
  });

  // Stable callbacks for child props to reduce re-renders
  const handleSelectFile = useCallback((f: FileEntry) => setSelectedFile(f), []);
  const listOnFolderOpen = useCallback(
    (folder: FileEntry) => {
      clearActiveSmartFolder();
      setCurrentPath(folder.path.replace(/\/$/, ''));
    },
    [setCurrentPath, clearActiveSmartFolder]
  );
  const gridOnFolderOpen = listOnFolderOpen;

  const refreshVisibleViewsRef = useRef(refreshVisibleViews);
  useEffect(() => {
    refreshVisibleViewsRef.current = refreshVisibleViews;
  }, [refreshVisibleViews]);

  const handlePaletteGoUp = useCallback(() => {
    const path = normalizePath(currentPathRef.current);
    if (!path) return;
    if (viewModeRef.current === 'column') {
      const built = buildPathStackFromPath(path);
      if (built.length > 1) {
        const newPath = built[built.length - 2];
        setCurrentPath(newPath);
        setPathStack(buildPathStackFromPath(newPath));
      }
    } else {
      const parent = path.replace(/\/$/, '').replace(/[\\/][^\\/]+$/, '') || '/';
      setCurrentPath(parent);
    }
  }, [setCurrentPath, setPathStack]);

  const handleToggleHidden = useCallback(() => {
    const next = !useFileStore.getState().showHidden;
    setShowHidden(next);
  }, [setShowHidden]);

  const handleTogglePreview = useCallback(() => {
    const next = !useFileStore.getState().showPreviewPanel;
    setShowPreviewPanel(next);
  }, [setShowPreviewPanel]);

  const handleToggleStatusBar = useCallback(() => {
    const next = !useFileStore.getState().showStatusBar;
    setShowStatusBar(next);
  }, [setShowStatusBar]);

  const handleCloseActiveTab = useCallback(() => {
    closeTab(activeTabIdRef.current);
  }, [activeTabIdRef, closeTab]);

  const handleAddFavoriteFromPalette = useCallback(() => {
    const path = currentPathRef.current;
    if (path) {
      addFavorite(path);
    }
  }, [addFavorite]);

  const handleUndoFromPalette = useCallback(async () => {
    const success = await useUndoRedoStore.getState().undo();
    if (!success && useUndoRedoStore.getState().undoStack.length > 0) {
      showToast('Undo failed', { type: 'error' });
    }
  }, [showToast]);

  const handleRedoFromPalette = useCallback(async () => {
    const success = await useUndoRedoStore.getState().redo();
    if (!success && useUndoRedoStore.getState().redoStack.length > 0) {
      showToast('Redo failed', { type: 'error' });
    }
  }, [showToast]);

  const handleSaveWorkspace = useCallback(() => {
    setWorkspaceNameDialogOpen(true);
  }, []);

  const handleRefreshFromPalette = useCallback(() => {
    void refreshVisibleViewsRef.current();
  }, []);

  const navigateToChosenFolder = useCallback(
    (path: string) => {
      clearActiveSmartFolder();
      setError(null);
      setFolderPickerError(null);
      setCurrentPath(path);
      if (viewMode === 'column') {
        setPathStack(buildPathStackFromPath(path));
      }
    },
    [clearActiveSmartFolder, setCurrentPath, setError, setPathStack, viewMode]
  );

  const handleChooseFolder = useCallback(async () => {
    setChoosingFolder(true);
    setFolderPickerError(null);
    try {
      const selectedPath = await chooseFolder(currentPath || undefined);
      if (selectedPath) {
        navigateToChosenFolder(selectedPath);
      }
    } catch (pickerError) {
      setFolderPickerError(formatErrorMessage(pickerError));
    } finally {
      setChoosingFolder(false);
    }
  }, [currentPath, navigateToChosenFolder]);

  const handleGoToFolderFromPalette = useCallback(() => {
    setGoToFolderOpen(true);
  }, []);

  const handleNewFolderFromPalette = useCallback(() => {
    const { setDraftNew } = useFileStore.getState();
    const id = `new-folder-${Date.now()}`;
    setDraftNew({ id, parentPath: currentPathRef.current, name: '' });
  }, []);

  const handleOpenSettingsFromPalette = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleShowKeyboardShortcutsFromPalette = useCallback(() => {
    setShortcutsOverlayOpen(true);
  }, []);

  const handleOpenWorkspaceManagerFromPalette = useCallback(() => {
    setWorkspaceManagerOpen(true);
  }, []);

  const paletteCommandHandlers = useMemo(
    () => ({
      goBack: handleGoBack,
      goForward: handleGoForward,
      goToFolder: handleGoToFolderFromPalette,
      goUp: handlePaletteGoUp,
      clearHistory: handleClearHistoryFromPalette,
      setViewMode,
      toggleHidden: handleToggleHidden,
      togglePreview: handleTogglePreview,
      toggleStatusBar: handleToggleStatusBar,
      refresh: handleRefreshFromPalette,
      addTab,
      closeActiveTab: handleCloseActiveTab,
      newFolder: handleNewFolderFromPalette,
      undo: handleUndoFromPalette,
      redo: handleRedoFromPalette,
      openSettings: handleOpenSettingsFromPalette,
      setTheme,
      addFavorite: handleAddFavoriteFromPalette,
      showKeyboardShortcuts: handleShowKeyboardShortcutsFromPalette,
      openWorkspaceManager: handleOpenWorkspaceManagerFromPalette,
      saveWorkspace: handleSaveWorkspace,
    }),
    [
      addTab,
      handleAddFavoriteFromPalette,
      handleClearHistoryFromPalette,
      handleCloseActiveTab,
      handleGoBack,
      handleGoForward,
      handleGoToFolderFromPalette,
      handleNewFolderFromPalette,
      handleOpenSettingsFromPalette,
      handleOpenWorkspaceManagerFromPalette,
      handlePaletteGoUp,
      handleRedoFromPalette,
      handleRefreshFromPalette,
      handleSaveWorkspace,
      handleShowKeyboardShortcutsFromPalette,
      handleToggleHidden,
      handleTogglePreview,
      handleToggleStatusBar,
      handleUndoFromPalette,
      setTheme,
      setViewMode,
    ]
  );

  const paletteCommands = useAppCommands({
    showHidden,
    showPreviewPanel,
    showStatusBar,
    handlers: paletteCommandHandlers,
  });

  const handleOpenCommandPaletteShortcut = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);

  const handleToggleDebugPanelShortcut = useCallback(() => {
    if (isDevBuild) setDebugPanelOpen((prev) => !prev);
  }, []);

  const handleToggleShortcutsOverlayShortcut = useCallback(() => {
    setShortcutsOverlayOpen((prev) => !prev);
  }, []);

  const deleteSelectedFiles = useCallback(
    async (targets: FileEntry[], permanent = false) => {
      const success = await deleteWithUndo(targets, showToast, refreshVisibleViews, { permanent });
      if (success) {
        setSelectedPaths([]);
        setSelectionCursorPath(null);
      }
    },
    [refreshVisibleViews, setSelectedPaths, setSelectionCursorPath, showToast]
  );

  const handleDeleteSelection = useCallback(() => {
    const targets = getSelectedFilesRef.current?.() ?? [];
    if (!targets.length) return;
    if (useFileStore.getState().confirmBeforeDelete) setShortcutDeleteFiles(targets);
    else void deleteSelectedFiles(targets);
  }, [deleteSelectedFiles, getSelectedFilesRef]);

  const handleActivateTabOffset = useCallback(
    (offset: number) => {
      const current = tabs.findIndex((tab) => tab.id === activeTabId);
      if (current < 0 || tabs.length < 2) return;
      const next = (current + offset + tabs.length) % tabs.length;
      activateTab(tabs[next].id);
    },
    [activateTab, activeTabId, tabs]
  );

  const handleFocusSearch = useCallback(() => {
    document.getElementById('explorie-search-input')?.focus();
  }, []);

  const handleTypeToSelect = useCallback(
    (key: string) => {
      const now = Date.now();
      const previous = now - typeSelectRef.current.at < 750 ? typeSelectRef.current.value : '';
      const value = `${previous}${key}`.toLocaleLowerCase();
      typeSelectRef.current = { value, at: now };
      const source =
        viewMode === 'column' ? (columnFiles[pathStack[pathStack.length - 1]] ?? []) : files;
      const query = searchQuery.trim().toLocaleLowerCase();
      const candidates = sortFiles(
        source.filter((file) => {
          const name = file.name ?? file.path.split(/[/\\]/).pop() ?? file.path;
          if (!showHidden && (file.hidden || name.startsWith('.'))) return false;
          if (filterMode === 'folders' && !file.is_dir) return false;
          if (filterMode === 'files' && file.is_dir) return false;
          return !query || name.toLocaleLowerCase().includes(query);
        }),
        sortKey as SortKey,
        sortDir as SortDir
      );
      const find = (prefix: string) =>
        candidates.find((file) =>
          (file.name ?? file.path.split(/[/\\]/).pop() ?? file.path)
            .toLocaleLowerCase()
            .startsWith(prefix)
        );
      const match = find(value) ?? (value.length > 1 ? find(key.toLocaleLowerCase()) : undefined);
      if (!match) return;
      setSelectedPaths([match.path]);
      setSelectionCursorPath(match.path);
    },
    [
      columnFiles,
      files,
      filterMode,
      pathStack,
      searchQuery,
      setSelectedPaths,
      setSelectionCursorPath,
      showHidden,
      sortDir,
      sortKey,
      viewMode,
    ]
  );

  useAppKeyboardShortcuts({
    activeTabId,
    currentPath,
    selectedFileIsPreviewable: !!selectedFile && !selectedFile.is_dir,
    isQuickLookOpen: quickLook.isQuickLookOpen,
    viewMode,
    canUndo,
    canRedo,
    addTab,
    closeTab,
    goBack: handleGoBack,
    goForward: handleGoForward,
    openQuickLook: quickLook.openSelected,
    openGoToFolder: handleGoToFolderFromPalette,
    openCommandPalette: handleOpenCommandPaletteShortcut,
    toggleDebugPanel: handleToggleDebugPanelShortcut,
    addFavorite,
    toggleShortcutsOverlay: handleToggleShortcutsOverlayShortcut,
    undo: undoAction,
    redo: redoAction,
    increaseThumbnailSize,
    decreaseThumbnailSize,
    deleteSelection: handleDeleteSelection,
    goUp: handlePaletteGoUp,
    refresh: handleRefreshFromPalette,
    setViewMode,
    toggleHidden: handleToggleHidden,
    activateTabOffset: handleActivateTabOffset,
    focusSearch: handleFocusSearch,
    typeToSelect: handleTypeToSelect,
  });

  const appBodyStyle: CssVariableStyle<'--sidebar-width'> = {
    '--sidebar-width': `${paneLayout.sidebarWidth}px`,
  };
  const waitingForInitialPath = pathInitializing && !currentPath && !activeSmartFolder;
  const startupBlocked = !pathInitializing && !currentPath && !activeSmartFolder;

  return (
    <>
      <SkipLinks />
      <div className={styles.appContainer}>
        {showTitleBar && (
          <div className={styles.titleBarContainer}>
            <InlineErrorBoundary name="TitleBar">
              <TitleBar showWindowControls={showWindowControls} />
            </InlineErrorBoundary>
          </div>
        )}
        <div ref={appBodyRef} className={styles.appBody} style={appBodyStyle}>
          <InlineErrorBoundary name="Sidebar">
            <nav id="main-navigation" aria-label="Main navigation">
              <Sidebar
                currentPath={currentPath}
                recents={recents}
                onSelectLocation={setCurrentPath}
                onOpenSettings={() => setSettingsOpen(true)}
                fileDragActive={draggingItemIds.size > 0}
                onFileDragHoverPath={handleHoverContainerPath}
                onFileDragHoverFavorites={handleHoverFavorites}
                onFileDragOpenPath={handleDragOpenPath}
              />
            </nav>
          </InlineErrorBoundary>
          <div
            className={styles.sidebarResizer}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={160}
            aria-valuemax={480}
            aria-valuenow={paneLayout.sidebarWidth}
            aria-valuetext={
              paneLayout.sidebarWidth === sidebarWidth
                ? `${sidebarWidth} pixels`
                : `${paneLayout.sidebarWidth} pixels; preferred ${sidebarWidth}`
            }
            tabIndex={0}
            onMouseDown={handleSidebarResizeStart}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0;
              if (!delta) return;
              event.preventDefault();
              setSidebarWidth(Math.min(480, Math.max(160, sidebarWidth + delta)));
            }}
          />
          <main id="main-content" className={styles.mainArea} aria-label="File browser">
            <div className={styles.mainContent}>
              <div className={styles.contentWrapper}>
                <div className={styles.topBarContainer}>
                  <TopBar
                    currentPath={currentPath}
                    onUp={() => {
                      const path = normalizePath(currentPath);
                      clearActiveSmartFolder();
                      if (viewMode === 'column') {
                        const built = buildPathStackFromPath(path);
                        if (built.length > 1) {
                          const newPath = built[built.length - 2];
                          setCurrentPath(newPath);
                          setPathStack(buildPathStackFromPath(newPath));
                        }
                      } else {
                        // list/grid behavior: go up one directory from currentPath
                        const parent = path.replace(/\/$/, '').replace(/[\\/][^\\/]+$/, '') || '/';
                        setCurrentPath(parent);
                      }
                    }}
                    onNavigate={(path) => {
                      clearActiveSmartFolder();
                      setCurrentPath(path);
                      if (viewMode === 'column') {
                        setPathStack(buildPathStackFromPath(path));
                      }
                    }}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    canGoBack={canGoBack}
                    canGoForward={canGoForward}
                    onBack={handleGoBack}
                    onForward={handleGoForward}
                    backHistory={backHistory}
                    forwardHistory={forwardHistory}
                    onBackHistorySelect={handleGoToBackIndex}
                    onForwardHistorySelect={handleGoToForwardIndex}
                  />
                  <TabsBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onActivate={activateTab}
                    onClose={closeTab}
                    onAdd={addTab}
                    onReorder={reorderTabs}
                    fileDragActive={draggingItemIds.size > 0}
                    onFileDragHover={handleHoverContainerPath}
                  />
                </div>
                {/* Crash recovery banner */}
                {recoveryAvailable && (
                  <InlineErrorBoundary name="RecoveryBanner">
                    <RecoveryBanner
                      tabCount={recoveryInfo.tabCount}
                      lastSaveAt={recoveryInfo.lastSaveAt}
                      lastPath={recoveryInfo.currentPath}
                      onRecover={acceptRecovery}
                      onDismiss={dismissRecovery}
                    />
                  </InlineErrorBoundary>
                )}
                {waitingForInitialPath && (
                  <div className={styles.loadingMessage} role="status" aria-live="polite">
                    Finding a folder…
                  </div>
                )}
                {startupBlocked && (
                  <StartupLocationState
                    initializationError={initializationError}
                    choosingFolder={choosingFolder}
                    pickerError={folderPickerError}
                    onChooseFolder={() => void handleChooseFolder()}
                    onEnterPath={() => setGoToFolderOpen(true)}
                    onRetryInitialization={retryInitialization}
                  />
                )}
                {!waitingForInitialPath && !startupBlocked && loading && (
                  <div className={styles.loadingMessage} role="status" aria-live="polite">
                    Loading files…
                  </div>
                )}
                {!waitingForInitialPath && !startupBlocked && error && (
                  <FolderLoadErrorState
                    path={currentPath}
                    error={error}
                    choosingFolder={choosingFolder}
                    pickerError={folderPickerError}
                    onRetry={handleRefreshFromPalette}
                    onChooseFolder={() => void handleChooseFolder()}
                  />
                )}
                {!waitingForInitialPath && !startupBlocked && !loading && !error && (
                  <ErrorBoundary name="FileView">
                    <div id="file-list" aria-label="File list" role="region">
                      {viewMode === 'list' && (
                        <ListView
                          key={`list-${dndEpoch}`}
                          currentPath={currentPath}
                          dragCombineTargetId={combineTargetId}
                          files={files}
                          onFileSelect={handleSelectFile}
                          onFolderOpen={listOnFolderOpen}
                          isDragging={draggingItemIds.size > 0}
                          draggingItemIds={draggingItemIds}
                          onBeginDrag={beginDrag}
                          onHoverFolder={handleHoverFolder}
                          onHoverContainer={(path) => handleHoverContainerPath(path)}
                          getSelectedFilesRef={getSelectedFilesRef}
                        />
                      )}
                      {viewMode === 'column' && (
                        <ColumnView
                          key={`col-${dndEpoch}`}
                          pathStack={pathStack}
                          columnFiles={columnFiles}
                          onFolderClick={handleColumnFolderClick}
                          onColumnBack={handleColumnBack}
                          onFileSelect={setSelectedFile}
                          dragCombineTargetId={combineTargetId}
                          draggingItemIds={draggingItemIds}
                          onBeginDrag={beginDrag}
                          onHoverContainerPath={handleHoverContainerPath}
                          onHoverFolder={handleHoverFolder}
                          previewWidth={paneLayout.previewWidth}
                          previewVisible={paneLayout.previewVisible}
                          getSelectedFilesRef={getSelectedFilesRef}
                        />
                      )}
                      {/* Hybrid view removed */}
                      {viewMode === 'grid' && (
                        <GridView
                          key={`grid-${dndEpoch}`}
                          dragCombineTargetId={combineTargetId}
                          currentPath={currentPath}
                          files={files}
                          onFileSelect={handleSelectFile}
                          onFolderOpen={gridOnFolderOpen}
                          isDragging={draggingItemIds.size > 0}
                          draggingItemIds={draggingItemIds}
                          onBeginDrag={beginDrag}
                          onHoverFolder={handleHoverFolder}
                          onHoverContainer={(path) => handleHoverContainerPath(path)}
                          getSelectedFilesRef={getSelectedFilesRef}
                        />
                      )}
                      <DragOverlay
                        overlay={dragOverlay}
                        position={dragPos}
                        reduceMotion={reduceMotion}
                        onGatherComplete={handleGatherComplete}
                        onExitComplete={handleDragAnimationComplete}
                      />
                    </div>
                  </ErrorBoundary>
                )}
              </div>
              {paneLayout.previewVisible && (
                <>
                  <div
                    className={styles.previewResizer}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize preview panel"
                    aria-valuemin={280}
                    aria-valuemax={720}
                    aria-valuenow={paneLayout.previewWidth}
                    aria-valuetext={
                      paneLayout.previewWidth === previewWidth
                        ? `${previewWidth} pixels`
                        : `${paneLayout.previewWidth} pixels; preferred ${previewWidth}`
                    }
                    tabIndex={0}
                    onMouseDown={handlePreviewResizeStart}
                    onKeyDown={(event) => {
                      const delta =
                        event.key === 'ArrowLeft' ? 10 : event.key === 'ArrowRight' ? -10 : 0;
                      if (!delta) return;
                      event.preventDefault();
                      setPreviewWidth(Math.min(720, Math.max(280, previewWidth + delta)));
                    }}
                  />
                  <div
                    className={styles.previewPanel}
                    style={{ width: `${paneLayout.previewWidth}px` }}
                  >
                    {selectedFile && (
                      <ErrorBoundary name="Preview">
                        <FilePreviewer
                          key={selectedFile.id}
                          file={selectedFile}
                          onClose={() => setSelectedFile(null)}
                        />
                      </ErrorBoundary>
                    )}
                  </div>
                </>
              )}
            </div>
            {showStatusBar && (
              <InlineErrorBoundary name="StatusBar">
                <StatusBar
                  files={viewMode === 'column' ? columnFiles[currentPath] || [] : files}
                  selectedFile={selectedFile}
                  currentPath={currentPath}
                />
              </InlineErrorBoundary>
            )}
          </main>
        </div>
      </div>
      {/* Global settings modal */}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* Go to Folder dialog */}
      <GoToFolderDialog
        open={goToFolderOpen}
        currentPath={currentPath}
        onNavigate={(path) => {
          navigateToChosenFolder(path);
        }}
        onClose={() => setGoToFolderOpen(false)}
      />
      {/* Quick Look modal */}
      {quickLook.isQuickLookOpen && quickLook.quickLookFile && (
        <ErrorBoundary name="QuickLook" fallback={null}>
          <QuickLookModal
            file={quickLook.quickLookFile}
            files={quickLook.quickLookFiles}
            onClose={quickLook.close}
            onNavigate={quickLook.navigateTo}
          />
        </ErrorBoundary>
      )}
      {/* Command Palette */}
      <InlineErrorBoundary name="CommandPalette">
        <CommandPalette
          open={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          commands={paletteCommands}
        />
      </InlineErrorBoundary>
      {/* Keyboard Shortcuts Overlay */}
      <InlineErrorBoundary name="KeyboardShortcuts">
        <KeyboardShortcutsOverlay
          open={shortcutsOverlayOpen}
          onClose={() => setShortcutsOverlayOpen(false)}
        />
      </InlineErrorBoundary>
      {/* Workspace Manager */}
      <InlineErrorBoundary name="WorkspaceManager">
        <WorkspaceManager
          open={workspaceManagerOpen}
          onClose={() => setWorkspaceManagerOpen(false)}
          currentTabs={tabs.map((t) => ({ id: t.id, path: t.path }))}
          activeTabId={activeTabId}
          onLoadWorkspace={handleLoadWorkspace}
          getWindowState={getWindowState}
          getSidebarState={getSidebarState}
        />
      </InlineErrorBoundary>
      <TextInputDialog
        open={workspaceNameDialogOpen}
        title="Save workspace"
        label="Workspace name"
        submitLabel="Save"
        validate={(value) => (!value ? 'Workspace name is required' : null)}
        onCancel={() => setWorkspaceNameDialogOpen(false)}
        onSubmit={(name) => {
          const workspaceTabs: WorkspaceTab[] = tabsRef.current.map((tab) => ({
            id: tab.id,
            path: tab.path,
          }));
          useFileStore.getState().saveWorkspace(name, workspaceTabs, activeTabIdRef.current);
          setWorkspaceNameDialogOpen(false);
        }}
      />
      {isDevBuild && (
        <InlineErrorBoundary name="DebugPanel">
          <DebugPanel open={debugPanelOpen} onClose={() => setDebugPanelOpen(false)} />
        </InlineErrorBoundary>
      )}
      <React.Suspense fallback={null}>
        <LazySecureDeleteDialog
          open={shortcutDeleteFiles.length > 0}
          files={shortcutDeleteFiles}
          showDontAskAgain
          onDontAskAgainChange={(checked) => {
            if (checked) useFileStore.getState().setConfirmBeforeDelete(false);
          }}
          onCancel={() => setShortcutDeleteFiles([])}
          onConfirm={(permanent) => {
            const targets = shortcutDeleteFiles;
            setShortcutDeleteFiles([]);
            void deleteSelectedFiles(targets, permanent);
          }}
        />
      </React.Suspense>
      {/* Operation Progress Panel */}
      <InlineErrorBoundary name="OperationProgress">
        <OperationProgress />
      </InlineErrorBoundary>
      {/* File Conflict Resolution Dialog */}
      <InlineErrorBoundary name="ConflictResolution">
        <ConflictResolutionDialogConnected />
      </InlineErrorBoundary>
    </>
  );
}

/** Connected Conflict Resolution Dialog that reads from the global store */
function ConflictResolutionDialogConnected() {
  const { isOpen, conflicts, currentIndex, operationType, resolveConflict, cancelAll } =
    useConflictResolutionStore();

  const currentConflict = conflicts[currentIndex]?.conflict ?? null;
  const totalConflicts = conflicts.length;

  return (
    <ConflictResolutionDialog
      open={isOpen}
      conflict={currentConflict}
      operationType={operationType}
      currentIndex={currentIndex + 1}
      totalConflicts={totalConflicts}
      onResolve={resolveConflict}
      onCancel={cancelAll}
    />
  );
}
