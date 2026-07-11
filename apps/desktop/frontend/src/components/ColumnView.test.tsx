import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColumnView } from './ColumnView';
import type { FileEntry } from '../store';

const mocks = vi.hoisted(() => ({
  archiveActionFile: null as FileEntry | null,
  archiveActionFiles: [] as FileEntry[],
  contextActionFiles: [] as FileEntry[],
  contextOpenForEmpty: vi.fn(),
  contextOpenForFiles: vi.fn(),
  createFolderIn: vi.fn(),
  deleteWithUndo: vi.fn(),
  invoke: vi.fn(),
  renamePath: vi.fn(),
  reportError: vi.fn(),
}));

// Mock ResizeObserver for tests
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

type StoreState = {
  showHidden: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  filterMode: 'all' | 'folders' | 'files';
  searchQuery: string;
  draftNew: { id: string; parentPath: string; name: string } | null;
  editingId: string | null;
  pathStack: string[];
  clipboard: null | { mode: 'copy' | 'cut'; items: FileEntry[]; sourcePath: string };
  confirmBeforeDelete: boolean;
  selectedPaths: string[];
  selectionCursorPath: string | null;
  setEditingId: (id: string | null) => void;
  setDraftNew: (draft: { id: string; parentPath: string; name: string } | null) => void;
  setPathStack: (stack: string[]) => void;
  setFiles: (files: any) => void;
  setConfirmBeforeDelete: (confirm: boolean) => void;
  setSelectedPaths: (paths: string[]) => void;
  setSelectionCursorPath: (path: string | null) => void;
};

let storeState: StoreState;

vi.mock('../store', () => {
  const useFileStore = (selector?: (state: StoreState) => any) => {
    return selector ? selector(storeState) : storeState;
  };
  useFileStore.getState = () => storeState;
  return { useFileStore };
});

vi.mock('../hooks/useDragStart', () => ({
  useDragStart: ({
    onBeginDrag,
  }: {
    onBeginDrag?: (file: FileEntry, point: { x: number; y: number }) => void;
  }) => ({
    onMouseDown: (_event: React.MouseEvent, file: FileEntry) => {
      onBeginDrag?.(file, { x: 0, y: 0 });
    },
  }),
}));

vi.mock('../hooks/useMarqueeSelection', () => ({
  useMarqueeSelection: () => ({
    isActive: false,
    rect: null,
    onMouseDown: vi.fn(),
  }),
}));

vi.mock('./ContextMenu', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ContextMenu: ({
      onCompress,
      onDeleteConfirm,
      onExtract,
      onRefresh,
      onRename,
    }: {
      onCompress: (files: FileEntry[]) => void;
      onDeleteConfirm: (files: FileEntry[]) => void;
      onExtract: (file: FileEntry) => void;
      onRefresh: () => void;
      onRename: (file: FileEntry) => void;
    }) =>
      ReactActual.createElement(
        'div',
        { 'data-testid': 'context-menu-actions' },
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onRename(mocks.archiveActionFile!) },
          'Mock rename action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onDeleteConfirm(mocks.contextActionFiles) },
          'Mock delete action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onCompress(mocks.archiveActionFiles) },
          'Mock compress action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onExtract(mocks.archiveActionFile!) },
          'Mock extract action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onRefresh() },
          'Mock refresh action'
        )
      ),
    useContextMenu: () => ({
      state: { open: false, containerPath: '/root' },
      openForEmpty: mocks.contextOpenForEmpty,
      openForFiles: mocks.contextOpenForFiles,
      close: vi.fn(),
    }),
  };
});

vi.mock('./ArchiveDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ArchiveDialog: ({
      currentPath,
      mode,
      onClose,
      onSuccess,
      open,
    }: {
      currentPath: string;
      mode: 'compress' | 'extract';
      onClose: () => void;
      onSuccess: () => void;
      open: boolean;
    }) =>
      open
        ? ReactActual.createElement(
            'div',
            { 'data-testid': 'archive-dialog' },
            ReactActual.createElement('span', null, `Archive mode: ${mode}`),
            ReactActual.createElement('span', null, `Archive path: ${currentPath}`),
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: onSuccess },
              'Mock archive success'
            ),
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: onClose },
              'Mock close archive'
            )
          )
        : null,
  };
});

vi.mock('./SecureDeleteDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    SecureDeleteDialog: ({
      onCancel,
      onConfirm,
      onDontAskAgainChange,
      open,
    }: {
      onCancel: () => void;
      onConfirm: (permanent: boolean) => void;
      onDontAskAgainChange?: (checked: boolean) => void;
      open: boolean;
    }) =>
      open
        ? ReactActual.createElement(
            'div',
            { 'data-testid': 'delete-dialog' },
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: () => onDontAskAgainChange?.(true) },
              'Mock do not ask'
            ),
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: () => onConfirm(true) },
              'Mock permanent delete'
            ),
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: onCancel },
              'Mock cancel delete'
            )
          )
        : null,
  };
});

vi.mock('./Toast', () => ({
  useToast: () => ({
    toasts: [],
    show: vi.fn(),
    dismiss: vi.fn(),
    dismissAll: vi.fn(),
  }),
}));

vi.mock('../utils/fs', () => ({
  createFolderIn: mocks.createFolderIn,
  joinPaths: (parent: string, child: string) => `${parent.replace(/[\\/]+$/, '')}/${child}`,
  renamePath: mocks.renamePath,
}));

vi.mock('../utils/fileOperations', () => ({
  deleteWithUndo: mocks.deleteWithUndo,
}));

vi.mock('../utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

Element.prototype.scrollIntoView = vi.fn();

function makeEntry(path: string, overrides: Record<string, any> = {}) {
  const name = path.split(/[/\\]/).pop() || path;
  return {
    id: overrides.id ?? path,
    path,
    name,
    size: overrides.is_dir ? 0 : 20,
    modified: 0,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function getColumnContainer(container: HTMLElement) {
  const columnContainer = container.querySelector('div[tabindex="0"]');
  expect(columnContainer).not.toBeNull();
  return columnContainer as HTMLElement;
}

describe('ColumnView', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.archiveActionFile = null;
    mocks.archiveActionFiles = [];
    mocks.contextActionFiles = [];
    mocks.createFolderIn.mockResolvedValue('/root/New Folder');
    mocks.deleteWithUndo.mockResolvedValue(true);
    mocks.invoke.mockResolvedValue([]);
    mocks.renamePath.mockResolvedValue('/root/renamed.txt');
    storeState = {
      showHidden: false,
      sortKey: 'name',
      sortDir: 'asc',
      filterMode: 'all',
      searchQuery: '',
      draftNew: null,
      editingId: null,
      pathStack: ['/root', '/root/docs'],
      clipboard: null,
      confirmBeforeDelete: true,
      selectedPaths: [],
      selectionCursorPath: null,
      setEditingId: vi.fn(),
      setDraftNew: vi.fn(),
      setPathStack: vi.fn(),
      setFiles: vi.fn(),
      setConfirmBeforeDelete: vi.fn(),
      setSelectedPaths: vi.fn((paths) => {
        storeState.selectedPaths = paths;
      }),
      setSelectionCursorPath: vi.fn((path) => {
        storeState.selectionCursorPath = path;
      }),
    };
  });

  it('renders columns and items for each path', () => {
    storeState.pathStack = ['/render', '/render/docs'];
    const columnFiles = {
      '/render': [makeEntry('/render/docs', { id: 'folder-1', is_dir: true })],
      '/render/docs': [makeEntry('/render/docs/readme.md', { id: 'file-1' })],
    };

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={columnFiles as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    expect(screen.getByText('render')).toBeInTheDocument();
    expect(screen.getAllByText('docs').length).toBeGreaterThan(0);
    expect(screen.getByText('readme.md')).toBeInTheDocument();
  });

  it('filters hidden entries, folder mode, search results, and draft folders', () => {
    storeState.pathStack = ['/filter'];
    storeState.filterMode = 'folders';
    storeState.searchQuery = 'project';
    storeState.draftNew = { id: 'draft-folder', parentPath: '/filter', name: 'Project Draft' };
    const files = [
      makeEntry('/filter/.project-cache', { id: 'hidden-folder', is_dir: true, hidden: true }),
      makeEntry('/filter/project-notes.txt', { id: 'project-file', is_dir: false }),
      makeEntry('/filter/Project Folder', { id: 'project-folder', is_dir: true }),
      makeEntry('/filter/Downloads', { id: 'downloads-folder', is_dir: true }),
    ];

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/filter': files } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    expect(screen.getByText('Project Draft')).toBeInTheDocument();
    expect(screen.getByText('Project Folder')).toBeInTheDocument();
    expect(screen.queryByText('.project-cache')).not.toBeInTheDocument();
    expect(screen.queryByText('project-notes.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('Downloads')).not.toBeInTheDocument();
  });

  it('opens the selected folder with ArrowRight', async () => {
    storeState.pathStack = ['/keyboard'];
    const folder = makeEntry('/keyboard/projects', { id: 'folder-projects', is_dir: true });
    const file = makeEntry('/keyboard/readme.md', { id: 'file-readme' });
    const onFolderClick = vi.fn();
    const onFileSelect = vi.fn();

    const { container } = render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/keyboard': [folder, file] } as any}
        onFolderClick={onFolderClick}
        onColumnBack={vi.fn()}
        onFileSelect={onFileSelect}
      />
    );

    fireEvent.click(screen.getByLabelText('Open folder projects'));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalledWith(folder));

    fireEvent.keyDown(getColumnContainer(container), { key: 'ArrowRight' });

    expect(onFolderClick).toHaveBeenCalledWith(0, folder);
  });

  it('commits inline rename without bubbling Enter into file open', async () => {
    storeState.pathStack = ['/rename'];
    storeState.editingId = 'file-original';
    const file = makeEntry('/rename/original.txt', { id: 'file-original' });

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/rename': [file] } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    const input = screen.getByDisplayValue('original.txt');
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.renamePath).toHaveBeenCalledWith('/rename/original.txt', 'renamed.txt')
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith('open_path', { path: '/rename/original.txt' });
  });

  it('reports inline rename failures against the original path', async () => {
    storeState.pathStack = ['/rename'];
    storeState.editingId = 'file-original';
    const file = makeEntry('/rename/original.txt', { id: 'file-original' });
    mocks.renamePath.mockRejectedValueOnce(new Error('denied'));

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/rename': [file] } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    const input = screen.getByDisplayValue('original.txt');
    fireEvent.change(input, { target: { value: 'blocked.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.reportError).toHaveBeenCalledWith(
        'Rename failed',
        expect.any(Error),
        expect.objectContaining({ context: { path: '/rename/original.txt' } })
      )
    );
    expect(storeState.setEditingId).toHaveBeenLastCalledWith(null);
  });

  it('handles keyboard select-all, arrow movement, rename, clear, and column back', async () => {
    storeState.pathStack = ['/keys', '/keys/projects'];
    const onFileSelect = vi.fn();
    const onColumnBack = vi.fn();
    const selectedFilesRef = {
      current: null,
    } as React.MutableRefObject<(() => FileEntry[]) | null>;
    const files = [
      makeEntry('/keys/projects/alpha.txt', { id: 'file-alpha' }),
      makeEntry('/keys/projects/bravo.txt', { id: 'file-bravo' }),
      makeEntry('/keys/projects/charlie.txt', { id: 'file-charlie' }),
    ];

    const { container } = render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/keys': [], '/keys/projects': files } as any}
        onFolderClick={vi.fn()}
        onColumnBack={onColumnBack}
        onFileSelect={onFileSelect}
        getSelectedFilesRef={selectedFilesRef}
      />
    );

    const columnContainer = getColumnContainer(container);
    fireEvent.keyDown(columnContainer, { key: 'a', ctrlKey: true });
    await waitFor(() =>
      expect(selectedFilesRef.current?.().map((file) => file.id)).toEqual([
        'file-alpha',
        'file-bravo',
        'file-charlie',
      ])
    );

    fireEvent.keyDown(columnContainer, { key: 'F2' });
    expect(storeState.setEditingId).toHaveBeenCalledWith('file-alpha');

    fireEvent.keyDown(columnContainer, { key: 'ArrowDown' });
    expect(onFileSelect).toHaveBeenLastCalledWith(files[1]);

    fireEvent.keyDown(columnContainer, { key: 'Escape' });
    await waitFor(() => expect(selectedFilesRef.current?.()).toEqual([]));

    fireEvent.keyDown(columnContainer, { key: 'ArrowLeft' });
    expect(onColumnBack).toHaveBeenCalledWith(0);
  });

  it('tracks range selection for keyboard clipboard operations', async () => {
    storeState.pathStack = ['/range'];
    const selectedFilesRef = {
      current: null,
    } as React.MutableRefObject<(() => any[]) | null>;
    const files = [
      makeEntry('/range/alpha.txt', { id: 'file-alpha' }),
      makeEntry('/range/bravo.txt', { id: 'file-bravo' }),
      makeEntry('/range/charlie.txt', { id: 'file-charlie' }),
    ];

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/range': files } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
        getSelectedFilesRef={selectedFilesRef}
      />
    );

    await waitFor(() => expect(selectedFilesRef.current).toEqual(expect.any(Function)));

    fireEvent.click(screen.getByLabelText('Select file alpha.txt'));
    fireEvent.click(screen.getByLabelText('Select file charlie.txt'), { shiftKey: true });

    await waitFor(() =>
      expect(selectedFilesRef.current?.().map((file) => file.id)).toEqual([
        'file-alpha',
        'file-bravo',
        'file-charlie',
      ])
    );
  });

  it('preserves a column multi-selection for context actions', async () => {
    storeState.pathStack = ['/context-selection'];
    const onFileSelect = vi.fn();
    const files = [
      makeEntry('/context-selection/a.txt', { id: 'context-a' }),
      makeEntry('/context-selection/b.txt', { id: 'context-b' }),
      makeEntry('/context-selection/c.txt', { id: 'context-c' }),
    ];

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/context-selection': files } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
        onFileSelect={onFileSelect}
      />
    );

    fireEvent.click(screen.getByLabelText('Select file a.txt'));
    fireEvent.click(screen.getByLabelText('Select file b.txt'), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByLabelText('Select file b.txt'));
    expect(mocks.contextOpenForFiles).toHaveBeenLastCalledWith(
      expect.any(Object),
      [files[0], files[1]],
      '/context-selection'
    );

    fireEvent.contextMenu(screen.getByLabelText('Select file c.txt'));
    expect(mocks.contextOpenForFiles).toHaveBeenLastCalledWith(
      expect.any(Object),
      [files[2]],
      '/context-selection'
    );
    expect(onFileSelect).toHaveBeenLastCalledWith(files[2]);
  });

  it('reports folder hover targets while dragging', () => {
    storeState.pathStack = ['/drag-hover'];
    const folder = makeEntry('/drag-hover/projects', { id: 'folder-projects', is_dir: true });
    const file = makeEntry('/drag-hover/readme.md', { id: 'file-readme' });
    const onHoverFolder = vi.fn();

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/drag-hover': [folder, file] } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
        draggingItemIds={new Set(['file-being-dragged'])}
        onHoverFolder={onHoverFolder}
      />
    );

    fireEvent.mouseEnter(screen.getByLabelText('Open folder projects'));
    expect(onHoverFolder).toHaveBeenLastCalledWith(folder);

    fireEvent.mouseEnter(screen.getByLabelText('Select file readme.md'));
    expect(onHoverFolder).toHaveBeenLastCalledWith(null);
  });

  it('opens item context menus and drives delete, refresh, and archive actions', async () => {
    storeState.pathStack = ['/actions'];
    const files = [
      makeEntry('/actions/archive.zip', { id: 'archive-file' }),
      makeEntry('/actions/readme.md', { id: 'readme-file' }),
    ];
    mocks.archiveActionFile = files[0];
    mocks.archiveActionFiles = [files[1]];
    mocks.contextActionFiles = [files[1]];

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/actions': files } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByLabelText('Select file readme.md'));
    expect(mocks.contextOpenForFiles).toHaveBeenCalledWith(
      expect.any(Object),
      [files[1]],
      '/actions'
    );

    fireEvent.click(screen.getByText('Mock delete action'));
    expect(await screen.findByTestId('delete-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock do not ask'));
    expect(storeState.setConfirmBeforeDelete).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByText('Mock permanent delete'));
    await waitFor(() =>
      expect(mocks.deleteWithUndo).toHaveBeenCalledWith(
        [files[1]],
        expect.any(Function),
        expect.any(Function),
        { permanent: true }
      )
    );

    fireEvent.click(screen.getByText('Mock refresh action'));
    expect(storeState.setPathStack).toHaveBeenCalledWith(['/actions']);

    fireEvent.click(screen.getByText('Mock compress action'));
    expect(await screen.findByText('Archive mode: compress')).toBeInTheDocument();
    expect(screen.getByText('Archive path: /root')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock archive success'));
    expect(storeState.setPathStack).toHaveBeenCalledWith(['/actions']);

    fireEvent.click(screen.getByText('Mock extract action'));
    expect(await screen.findByText('Archive mode: extract')).toBeInTheDocument();
  });

  it('persists resized column widths and supports double-click reset', async () => {
    storeState.pathStack = ['/resize'];

    const { container } = render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/resize': [] } as any}
        onFolderClick={vi.fn()}
        onColumnBack={vi.fn()}
      />
    );

    const resizeHandle = container.querySelector(
      '[title="Drag to resize column (double-click to reset)"]'
    );
    expect(resizeHandle).not.toBeNull();

    fireEvent.mouseDown(resizeHandle as Element, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 500 });
    fireEvent.mouseUp(window);

    await waitFor(() => expect(localStorage.getItem('explorie:columnWidths')).toContain('"0":600'));

    fireEvent.doubleClick(resizeHandle as Element);
    await waitFor(() => expect(localStorage.getItem('explorie:columnWidths')).toContain('"0":260'));
  });

  it('creates draft folders from inline rename without opening the draft row', async () => {
    storeState.pathStack = ['/draft'];
    storeState.draftNew = { id: 'draft-folder', parentPath: '/draft', name: 'Untitled Folder' };
    storeState.editingId = 'draft-folder';
    const onFolderClick = vi.fn();

    render(
      <ColumnView
        pathStack={storeState.pathStack}
        columnFiles={{ '/draft': [] } as any}
        onFolderClick={onFolderClick}
        onColumnBack={vi.fn()}
      />
    );

    const input = screen.getByDisplayValue('Untitled Folder');
    fireEvent.change(input, { target: { value: 'Project Docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.createFolderIn).toHaveBeenCalledWith('/draft', 'Project Docs')
    );
    expect(storeState.setDraftNew).toHaveBeenCalledWith(null);
    expect(storeState.setPathStack).toHaveBeenCalledWith(['/draft']);
    expect(onFolderClick).not.toHaveBeenCalled();
  });
});
