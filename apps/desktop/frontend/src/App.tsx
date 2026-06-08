import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useFileStore } from './store';
import { ListView } from './components/ListView';
import { ColumnView } from './components/ColumnView';
import { GridView } from './components/GridView';
import { Icon } from './components/Icon';
import { FilePreviewer } from './components/FilePreviewer';
import { QuickLookModal } from './components/QuickLookModal';
import { StatusBar } from './components/StatusBar';
import { GoToFolderDialog } from './components/GoToFolderDialog';
import { getCachedDirSize, setCachedDirSize } from './dirSizeCache';
import styles from './App.module.css'; // Import CSS Module
import { useShallow } from 'zustand/shallow';
import { useInitialPath } from './hooks/useInitialPath';
import { ToastProvider, useToast } from './components/Toast';
import { useUndoRedoStore, useCanUndo, useCanRedo } from './undoRedoStore';
import type { FileOperation } from './operationQueueStore';
import { useOperationQueueStore, formatBytes } from './operationQueueStore';
import { OperationProgress } from './components/OperationProgress';
import { AutoUpdater } from './components/AutoUpdater';
import { getParentPath as getParentPathUtil, normalizePath } from './utils/path';
import { runSmartFolderSearch } from './utils/smartFolderSearch';
import type { IconName } from './icons';
import type { SortDir, SortKey } from './components/FileTable';
import { useTabs } from './hooks/useTabs';
import { useWorkspaceManager } from './hooks/useWorkspaceManager';
import { useFileDragAndDrop } from './hooks/useFileDragAndDrop';
import { useNavigationHandlers } from './hooks/useNavigationHandlers';
import { useAppCommands } from './hooks/useAppCommands';
import { useAppKeyboardShortcuts } from './hooks/useAppKeyboardShortcuts';
import { useAppLayoutPersistence } from './hooks/useAppLayoutPersistence';
import { useQuickLookController } from './hooks/useQuickLookController';
import { formatErrorMessage } from './utils/errorMessages';
import { isTauriRuntime } from './services/updater';

const MAX_CONCURRENT_DIR_SIZE_REQUESTS = 4;
const isDevBuild = import.meta.env.DEV;
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
  onSize: (entry: FileEntry, size: number) => void,
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
        onSize(entry, cached);
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
        onSize(entry, size);
      } catch {
        inflight.delete(key);
        if (shouldCancel()) return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

import { InfoBox } from './components/InfoBox';
import { Sidebar } from './components/Sidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { TopBar } from './components/TopBar';
import { TitleBar } from './components/TitleBar';
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
  // Toast for notifications
  const { show: showToast } = useToast();

  // Operation queue notification setup
  const setOnOperationComplete = useOperationQueueStore((s) => s.setOnOperationComplete);

  // Connect operation completion to toast notifications
  const retryOperation = useOperationQueueStore((s) => s.retryOperation);
  useEffect(() => {
    const handleOperationComplete = (operation: FileOperation) => {
      const typeLabels: Record<string, string> = {
        copy: 'Copy',
        move: 'Move',
        delete: 'Delete',
        compress: 'Compress',
        extract: 'Extract',
      };
      const typeLabel = typeLabels[operation.type] || operation.type;
      const itemCount = operation.totalItems;
      const itemLabel = itemCount === 1 ? 'item' : 'items';

      if (operation.status === 'completed') {
        const sizeStr =
          operation.processedBytes > 0 ? ` (${formatBytes(operation.processedBytes)})` : '';
        showToast(`${typeLabel} completed: ${itemCount} ${itemLabel}${sizeStr}`, {
          type: 'success',
        });
      } else if (operation.status === 'failed') {
        // Show error toast with retry action
        showToast(`${typeLabel} failed: ${operation.error || 'Unknown error'}`, {
          type: 'error',
          action: {
            label: 'Retry',
            onClick: () => retryOperation(operation.id),
          },
          duration: 8000, // Give more time to see retry option
        });
      } else if (operation.status === 'cancelled') {
        showToast(`${typeLabel} cancelled`, { type: 'warning' });
      }
    };

    setOnOperationComplete(handleOperationComplete);

    return () => {
      setOnOperationComplete(null);
    };
  }, [showToast, setOnOperationComplete, retryOperation]);

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
    devMockEntries,
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
      devMockEntries: s.devMockEntries,
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
  const shouldUseDevMockEntries = isDevBuild && (!isTauriRuntime() || devMockEntries);

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
    handleSidebarResizeStart,
    handlePreviewResizeStart,
  } = useAppLayoutPersistence(styles.sidebarResizing);

  // Current path for active tab (persisted via hook)
  const { currentPath, setCurrentPath, initializing: pathInitializing } = useInitialPath();
  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  // Selected file for preview
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const previewPanelVisible = showPreviewPanel && !!selectedFile;

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

  // Info box visibility
  const [showInfoBox, setShowInfoBox] = useState(false);

  // Column view state can be extended here if needed

  // Settings panel visibility
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Go to Folder dialog visibility
  const [goToFolderOpen, setGoToFolderOpen] = useState(false);

  // Command Palette visibility
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Keyboard Shortcuts Overlay visibility
  const [shortcutsOverlayOpen, setShortcutsOverlayOpen] = useState(false);

  // Workspace Manager visibility
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);

  // Debug Panel visibility
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);

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
    const baseSm = density === 'compact' ? 3 : 4;
    const baseMd = density === 'compact' ? 6 : 8;
    const baseLg = density === 'compact' ? 9 : 12;
    const sm = Math.round(baseSm * uiScale * 100) / 100;
    const md = Math.round(baseMd * uiScale * 100) / 100;
    const lg = Math.round(baseLg * uiScale * 100) / 100;
    root.style.setProperty('--padding-sm', `${sm}px`);
    root.style.setProperty('--padding-md', `${md}px`);
    root.style.setProperty('--padding-lg', `${lg}px`);
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

  // Inject imported Google Fonts
  const importedFonts = useFileStore((s) => s.importedFonts);
  useEffect(() => {
    const head = document.head;
    // Remove previous injected links
    document
      .querySelectorAll('link[data-explorie-font="true"]')
      .forEach((n) => n.parentElement?.removeChild(n));
    for (const f of importedFonts || []) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = f.href;
      link.setAttribute('data-explorie-font', 'true');
      link.setAttribute('data-explorie-font-id', f.id);
      head.appendChild(link);
    }
  }, [importedFonts]);

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
              (entry, size) => {
                setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, size } : f)));
              },
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
    devMockEntries,
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
            // eslint-disable-next-line no-await-in-loop
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
                  (entry, size) => {
                    setColumnFiles((prev) => ({
                      ...prev,
                      [columnPath]: (prev[columnPath] || []).map((f) =>
                        f.id === entry.id ? { ...f, size } : f
                      ),
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
          (entry, size) => {
            setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, size } : f)));
          },
          () => false
        );
      }
    } else {
      const refreshed: { [path: string]: FileEntry[] } = {};
      for (const path of pathStack) {
        // eslint-disable-next-line no-await-in-loop
        const res = shouldUseDevMockEntries
          ? createDevMockEntries(path)
          : await invoke<FileEntry[]>('list_files', { path, calc_dir_size: false });
        refreshed[path] = res;
        if (showFolderSizes) {
          void fetchDirSizesConcurrent(
            res,
            (entry, size) => {
              setColumnFiles((prev) => ({
                ...prev,
                [path]: (prev[path] || []).map((f) => (f.id === entry.id ? { ...f, size } : f)),
              }));
            },
            () => false
          );
        }
      }
      setColumnFiles(refreshed);
    }
  }, [
    viewMode,
    currentPath,
    pathStack,
    showFolderSizes,
    setFiles,
    activeSmartFolder,
    shouldUseDevMockEntries,
  ]);

  // Helper: get parent directory of a path (supports Windows + POSIX)
  const getParentPath = useCallback((p: string): string => getParentPathUtil(p), []);

  const {
    draggingId,
    combineTargetId,
    dragOverlay,
    dragPos,
    dndEpoch,
    beginDrag,
    handleHoverFolder,
    handleHoverContainerPath,
  } = useFileDragAndDrop({
    files,
    columnFiles,
    viewMode,
    refreshVisibleViews,
    getParentPath,
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
    const name = window.prompt('Enter workspace name:');
    if (!name?.trim()) return;
    const workspaceTabs: WorkspaceTab[] = tabsRef.current.map((t) => ({ id: t.id, path: t.path }));
    useFileStore.getState().saveWorkspace(name.trim(), workspaceTabs, activeTabIdRef.current);
  }, [activeTabIdRef, tabsRef]);

  const handleRefreshFromPalette = useCallback(() => {
    void refreshVisibleViewsRef.current();
  }, []);

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
    setDebugPanelOpen((prev) => !prev);
  }, []);

  const handleToggleShortcutsOverlayShortcut = useCallback(() => {
    setShortcutsOverlayOpen((prev) => !prev);
  }, []);

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
  });

  const appBodyStyle: CssVariableStyle<'--sidebar-width'> = {
    '--sidebar-width': `${sidebarWidth}px`,
  };

  return (
    <>
      <SkipLinks />
      <AutoUpdater />
      <div className={styles.appContainer} role="application" aria-label="explorie File Manager">
        <div className={styles.titleBarContainer}>
          <InlineErrorBoundary name="TitleBar">
            <TitleBar />
          </InlineErrorBoundary>
        </div>
        <div className={styles.appBody} style={appBodyStyle}>
          <InlineErrorBoundary name="Sidebar">
            <nav id="main-navigation" aria-label="Main navigation">
              <Sidebar
                recents={recents}
                onSelectLocation={setCurrentPath}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </nav>
          </InlineErrorBoundary>
          <div
            className={styles.sidebarResizer}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={handleSidebarResizeStart}
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
                {showInfoBox && <InfoBox onClose={() => setShowInfoBox(false)} />}
                {loading && <p className={styles.loadingMessage}>Loading files…</p>}
                {error && <p className={styles.errorMessage}>Error: {error}</p>}
                {!loading && !error && (
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
                          isDragging={!!draggingId}
                          draggingItemId={draggingId ? draggingId.replace(/^file:/, '') : null}
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
                          draggingItemId={draggingId ? draggingId.replace(/^file:/, '') : null}
                          onBeginDrag={beginDrag}
                          onHoverContainerPath={handleHoverContainerPath}
                          onHoverFolder={handleHoverFolder}
                          previewWidth={previewWidth}
                          previewVisible={previewPanelVisible}
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
                          isDragging={!!draggingId}
                          draggingItemId={draggingId ? draggingId.replace(/^file:/, '') : null}
                          onBeginDrag={beginDrag}
                          onHoverFolder={handleHoverFolder}
                          onHoverContainer={(path) => handleHoverContainerPath(path)}
                          getSelectedFilesRef={getSelectedFilesRef}
                        />
                      )}
                      <DragOverlay overlay={dragOverlay} pos={dragPos} />
                    </div>
                  </ErrorBoundary>
                )}
              </div>
              {previewPanelVisible && (
                <>
                  <div
                    className={styles.previewResizer}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize preview panel"
                    onMouseDown={handlePreviewResizeStart}
                  />
                  <div className={styles.previewPanel} style={{ width: `${previewWidth}px` }}>
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
          clearActiveSmartFolder();
          setCurrentPath(path);
          if (viewMode === 'column') {
            setPathStack(buildPathStackFromPath(path));
          }
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
      {/* Debug Panel */}
      <InlineErrorBoundary name="DebugPanel">
        <DebugPanel open={debugPanelOpen} onClose={() => setDebugPanelOpen(false)} />
      </InlineErrorBoundary>
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

function DragOverlay({
  overlay,
  pos,
}: {
  overlay: { label: string; icon: string } | null;
  pos: { x: number; y: number };
}) {
  if (!overlay) return null;
  const overlayStyle: CssVariableStyle<'--drag-x' | '--drag-y'> = {
    '--drag-x': `${pos.x}px`,
    '--drag-y': `${pos.y}px`,
  };
  return (
    <div className={styles.dragOverlay} style={overlayStyle}>
      <span>
        <Icon name={overlay.icon as IconName} />
      </span>
      <span>{overlay.label}</span>
    </div>
  );
}
