import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import { useFileStore, type FileEntry } from './store';
import type { StoreState } from './store/types';

const initialFileStoreState = useFileStore.getState();

const fsWatch = vi.hoisted(() => {
  const callbacks: Array<(event: { type: unknown; paths: string[]; attrs: unknown }) => void> = [];
  const unwatch = vi.fn();
  const watch = vi.fn(
    async (
      _paths: string[],
      callback: (event: { type: unknown; paths: string[]; attrs: unknown }) => void
    ) => {
      callbacks.push(callback);
      return unwatch;
    }
  );
  return { callbacks, unwatch, watch };
});

const sampleFiles: FileEntry[] = [
  {
    id: 'alpha',
    path: '/root/alpha.txt',
    name: 'alpha.txt',
    size: 100,
    modified: 1,
    is_dir: false,
    custom: {},
  },
  {
    id: 'hidden',
    path: '/root/.hidden.txt',
    name: '.hidden.txt',
    size: 150,
    modified: 4,
    hidden: true,
    is_dir: false,
    custom: {},
  },
  {
    id: 'beta',
    path: '/root/beta.txt',
    name: 'beta.txt',
    size: 200,
    modified: 2,
    is_dir: false,
    custom: {},
  },
  {
    id: 'folder',
    path: '/root/Folder',
    name: 'Folder',
    size: 0,
    modified: 3,
    is_dir: true,
    custom: {},
  },
];

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) => {
    if (command === 'list_files') return sampleFiles;
    if (command === 'get_dir_size') return 0;
    return null;
  }),
}));

vi.mock('@tauri-apps/plugin-fs', async () => ({
  ...(await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs')),
  watch: fsWatch.watch,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('./components/Toast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  useToast: () => ({
    show: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
    dismissAll: vi.fn(),
  }),
}));

vi.mock('./operationQueueStore', () => ({
  formatBytes: (bytes: number) => `${bytes} B`,
  useOperationQueueStore: (
    selector: (state: {
      setOnOperationComplete: (callback: unknown) => void;
      retryOperation: (id: string) => void;
    }) => unknown
  ) =>
    selector({
      setOnOperationComplete: vi.fn(),
      retryOperation: vi.fn(),
    }),
}));

vi.mock('./undoRedoStore', () => ({
  useCanUndo: () => false,
  useCanRedo: () => false,
  useUndoRedoStore: (
    selector: (state: { undo: () => Promise<void>; redo: () => Promise<void> }) => unknown
  ) =>
    selector({
      undo: vi.fn(async () => {}),
      redo: vi.fn(async () => {}),
    }),
}));

vi.mock('./conflictResolutionStore', () => ({
  useConflictResolutionStore: () => ({
    isOpen: false,
    conflicts: [],
    currentIndex: 0,
    operationType: 'copy',
    resolveConflict: vi.fn(),
    cancelAll: vi.fn(),
  }),
}));

vi.mock('./hooks/useInitialPath', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    useInitialPath: () => {
      const [currentPath, setCurrentPath] = ReactActual.useState('/root');
      return { currentPath, setCurrentPath, initializing: false };
    },
  };
});

vi.mock('./hooks/useTabs', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    useTabs: () => {
      const [tabs, setTabs] = ReactActual.useState([{ id: 'tab-1', path: '/root' }]);
      const [activeTabId, setActiveTabId] = ReactActual.useState('tab-1');
      const tabsRef = ReactActual.useRef(tabs);
      const activeTabIdRef = ReactActual.useRef(activeTabId);
      ReactActual.useEffect(() => {
        tabsRef.current = tabs;
      }, [tabs]);
      ReactActual.useEffect(() => {
        activeTabIdRef.current = activeTabId;
      }, [activeTabId]);
      return {
        tabs,
        setTabs,
        tabsRef,
        activeTabId,
        setActiveTabId,
        activeTabIdRef,
        addTab: vi.fn(),
        closeTab: vi.fn(),
        activateTab: vi.fn(),
      };
    },
  };
});

vi.mock('./hooks/useWorkspaceManager', () => ({
  useWorkspaceManager: () => ({
    handleLoadWorkspace: vi.fn(),
    getWindowState: vi.fn(() => ({})),
    getSidebarState: vi.fn(() => ({})),
  }),
}));

vi.mock('./hooks/useCrashRecovery', () => ({
  useCrashRecovery: () => ({
    recoveryAvailable: false,
    recoveryInfo: { tabCount: 0, lastSaveAt: null, currentPath: '' },
    acceptRecovery: vi.fn(),
    dismissRecovery: vi.fn(),
  }),
}));

vi.mock('./hooks/useNavigationHandlers', () => ({
  useNavigationHandlers: () => ({
    canGoBack: false,
    canGoForward: false,
    backHistory: [],
    forwardHistory: [],
    handleGoBack: vi.fn(),
    handleGoForward: vi.fn(),
    handleGoToBackIndex: vi.fn(),
    handleGoToForwardIndex: vi.fn(),
    handleClearHistoryFromPalette: vi.fn(),
  }),
}));

vi.mock('./hooks/useFileDragAndDrop', () => ({
  useFileDragAndDrop: () => ({
    draggingItemIds: new Set<string>(),
    combineTargetId: null,
    dragOverlay: null,
    dragPos: { x: 0, y: 0 },
    dndEpoch: 0,
    beginDrag: vi.fn(),
    handleHoverFolder: vi.fn(),
    handleHoverContainerPath: vi.fn(),
    handleGatherComplete: vi.fn(),
    handleDragAnimationComplete: vi.fn(),
  }),
}));

vi.mock('./hooks/useKeyboardClipboard', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    useKeyboardClipboardManager: () => ({
      getSelectedFilesRef: ReactActual.useRef(null),
    }),
  };
});

vi.mock('./components/ThumbnailSizeSlider', () => ({
  useThumbnailSizeShortcuts: () => ({
    increase: vi.fn(),
    decrease: vi.fn(),
  }),
}));

vi.mock('./components/ListView', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ListView: ({
      files,
      onFileSelect,
    }: {
      files: FileEntry[];
      onFileSelect?: (file: FileEntry) => void;
    }) =>
      ReactActual.createElement(
        'div',
        { 'data-testid': 'mock-list-view' },
        files.map((file) =>
          ReactActual.createElement(
            'button',
            {
              key: file.id,
              type: 'button',
              onClick: () => onFileSelect?.(file),
            },
            `Select ${file.name ?? file.path}`
          )
        )
      ),
  };
});

vi.mock('./components/GridView', () => ({
  GridView: () => null,
}));

vi.mock('./components/ColumnView', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ColumnView: ({
      pathStack,
      columnFiles,
      onFileSelect,
    }: {
      pathStack: string[];
      columnFiles: Record<string, FileEntry[]>;
      onFileSelect?: (file: FileEntry) => void;
    }) =>
      ReactActual.createElement(
        'div',
        { 'data-testid': 'mock-column-view' },
        (columnFiles[pathStack[pathStack.length - 1] ?? ''] ?? []).map((file) =>
          ReactActual.createElement(
            'button',
            {
              key: file.id,
              type: 'button',
              onClick: () => onFileSelect?.(file),
            },
            `Column select ${file.name ?? file.path}`
          )
        )
      ),
  };
});

vi.mock('./components/FilePreviewer', () => ({
  FilePreviewer: ({ file }: { file: FileEntry }) => (
    <div data-testid="file-previewer">Previewing {file.name ?? file.path}</div>
  ),
}));

vi.mock('./components/TopBar', () => ({
  TopBar: () => <input aria-label="Mock path input" />,
}));

vi.mock('./components/TabsBar', () => ({
  TabsBar: () => null,
}));

vi.mock('./components/Sidebar', () => ({
  Sidebar: ({ onSelectLocation }: { onSelectLocation: (path: string) => void }) => (
    <button type="button" onClick={() => onSelectLocation('/other')}>
      Navigate elsewhere
    </button>
  ),
}));

vi.mock('./components/StatusBar', () => ({
  StatusBar: () => null,
}));

vi.mock('./components/SettingsPanel', () => ({
  SettingsPanel: () => null,
}));

vi.mock('./components/GoToFolderDialog', () => ({
  GoToFolderDialog: () => null,
}));

vi.mock('./components/CommandPalette', () => ({
  CommandPalette: () => null,
}));

vi.mock('./components/KeyboardShortcutsOverlay', () => ({
  KeyboardShortcutsOverlay: () => null,
}));

vi.mock('./components/SkipLinks', () => ({
  SkipLinks: () => null,
}));

vi.mock('./components/WorkspaceManager', () => ({
  WorkspaceManager: () => null,
}));

vi.mock('./components/ConflictResolutionDialog', () => ({
  ConflictResolutionDialog: () => null,
}));

vi.mock('./components/RecoveryBanner', () => ({
  RecoveryBanner: () => null,
}));

vi.mock('./components/DebugPanel', () => ({
  DebugPanel: () => null,
}));

vi.mock('./components/OperationProgress', () => ({
  OperationProgress: () => null,
}));

function resetFileStore(overrides: Partial<StoreState> = {}) {
  useFileStore.setState({
    ...initialFileStoreState,
    files: sampleFiles,
    loading: false,
    error: null,
    viewMode: 'list',
    theme: 'dark',
    pathStack: ['/root'],
    showPreviewPanel: false,
    showStatusBar: false,
    showFolderSizes: false,
    showHidden: false,
    activeSmartFolderId: null,
    smartFolders: {},
    clipboard: null,
    highContrast: false,
    accent: 'blue',
    accentCustom: '#7cc7ff',
    density: 'comfortable',
    uiScale: 1,
    font: 'mono',
    fontCustom: '',
    borderRadius: 0,
    iconSize: 16,
    reduceMotion: false,
    listRowHeight: 34,
    gridMinWidth: 140,
    ...overrides,
  });
}

function installBrowserStubs() {
  fsWatch.callbacks.length = 0;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('App spacing variables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    installBrowserStubs();
    resetFileStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('scales the complete spacing set for comfortable and compact density', async () => {
    render(<App />);
    const root = document.documentElement;
    const spacing = () =>
      ['xs', 'sm', 'md', 'lg', 'xl', '2xl'].map((size) =>
        root.style.getPropertyValue(`--padding-${size}`)
      );

    await waitFor(() => expect(spacing()).toEqual(['2px', '4px', '8px', '12px', '16px', '24px']));

    act(() => useFileStore.setState({ density: 'compact' }));
    await waitFor(() => expect(spacing()).toEqual(['2px', '3px', '6px', '9px', '12px', '18px']));

    act(() => useFileStore.setState({ uiScale: 1.4 }));
    await waitFor(() =>
      expect(spacing()).toEqual(['2.8px', '4.2px', '8.4px', '12.6px', '16.8px', '25.2px'])
    );
  });
});

describe('App Quick Look shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    installBrowserStubs();
    resetFileStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the selected file with Space and closes Quick Look with Space', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select alpha.txt' }));
    fireEvent.keyDown(window, { key: ' ' });

    expect(await screen.findByRole('heading', { name: 'alpha.txt' })).toBeInTheDocument();
    expect(screen.getByTestId('file-previewer')).toHaveTextContent('Previewing alpha.txt');

    fireEvent.keyDown(window, { key: ' ' });

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'alpha.txt' })).not.toBeInTheDocument()
    );
  });

  it('keeps Quick Look open while arrowing through visible files only', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select alpha.txt' }));
    fireEvent.keyDown(window, { key: ' ' });

    expect(await screen.findByRole('heading', { name: 'alpha.txt' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(await screen.findByRole('heading', { name: 'beta.txt' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '.hidden.txt' })).not.toBeInTheDocument();
    expect(screen.getByTestId('file-previewer')).toHaveTextContent('Previewing beta.txt');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });

    expect(await screen.findByRole('heading', { name: 'alpha.txt' })).toBeInTheDocument();
    expect(screen.getByTestId('file-previewer')).toHaveTextContent('Previewing alpha.txt');
  });

  it('uses the active column file sequence while Quick Look is open', async () => {
    resetFileStore({ files: [], viewMode: 'column', pathStack: ['/root'] });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Column select alpha.txt' }));
    fireEvent.keyDown(window, { key: ' ' });

    expect(await screen.findByRole('heading', { name: 'alpha.txt' })).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(await screen.findByRole('heading', { name: 'beta.txt' })).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('ignores Space from text inputs and selected folders', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select alpha.txt' }));
    fireEvent.keyDown(screen.getByLabelText('Mock path input'), { key: ' ' });
    expect(screen.queryByRole('heading', { name: 'alpha.txt' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select Folder' }));
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.queryByRole('heading', { name: 'Folder' })).not.toBeInTheDocument();

    expect(invoke).toHaveBeenCalledWith('list_files', {
      path: '/root',
      calc_dir_size: false,
    });
  });

  it('clears stale previews after navigation', async () => {
    resetFileStore({ showPreviewPanel: true });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select alpha.txt' }));
    expect(screen.getByTestId('file-previewer')).toHaveTextContent('Previewing alpha.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Navigate elsewhere' }));
    await waitFor(() => expect(screen.queryByTestId('file-previewer')).not.toBeInTheDocument());
  });

  it('keeps a failed folder load retryable', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockRejectedValueOnce(new Error('Access denied')).mockResolvedValueOnce(sampleFiles);

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Select alpha.txt' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('refreshes visible files after filesystem changes without reacting to reads', async () => {
    const invokeMock = vi.mocked(invoke);
    render(<App />);

    await screen.findByRole('button', { name: 'Select alpha.txt' });
    await waitFor(() => expect(fsWatch.callbacks).toHaveLength(1));
    invokeMock.mockClear();

    act(() =>
      fsWatch.callbacks[0]({
        type: { access: { kind: 'open', mode: 'read' } },
        paths: ['/root/alpha.txt'],
        attrs: null,
      })
    );
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce([
      ...sampleFiles,
      {
        id: 'gamma',
        path: '/root/gamma.txt',
        name: 'gamma.txt',
        size: 300,
        modified: 5,
        is_dir: false,
        custom: {},
      },
    ]);
    act(() =>
      fsWatch.callbacks[0]({
        type: { create: { kind: 'file' } },
        paths: ['/root/gamma.txt'],
        attrs: null,
      })
    );

    expect(await screen.findByRole('button', { name: 'Select gamma.txt' })).toBeVisible();
  });

  it('refetches cached columns when the path stack is used as a refresh signal', async () => {
    const invokeMock = vi.mocked(invoke);
    resetFileStore({ files: [], viewMode: 'column', pathStack: ['/root'] });
    render(<App />);

    await screen.findByRole('button', { name: 'Column select alpha.txt' });
    invokeMock.mockClear();

    act(() => useFileStore.getState().setPathStack(['/root']));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('list_files', {
        path: '/root',
        calc_dir_size: false,
      })
    );
  });

  it('provides keyboard-operable pane separators without application role', async () => {
    resetFileStore({ showPreviewPanel: true });
    render(<App />);

    expect(screen.queryByRole('application')).not.toBeInTheDocument();
    const sidebarSeparator = screen.getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.keyDown(sidebarSeparator, { key: 'ArrowRight' });
    expect(sidebarSeparator).toHaveAttribute('aria-valuenow', '230');

    fireEvent.click(await screen.findByRole('button', { name: 'Select alpha.txt' }));
    const previewSeparator = screen.getByRole('separator', { name: 'Resize preview panel' });
    fireEvent.keyDown(previewSeparator, { key: 'ArrowLeft' });
    expect(previewSeparator).toHaveAttribute('aria-valuenow', '358');
    expect(previewSeparator).toHaveAttribute('aria-valuetext', '358 pixels; preferred 370');
  });
});
