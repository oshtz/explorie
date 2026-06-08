import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../store';
import { GridView } from './GridView';

type DraftNew = { id: string; parentPath: string; name: string };

type StoreState = {
  showHidden: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  filterMode: 'all' | 'folders' | 'files';
  searchQuery: string;
  draftNew: DraftNew | null;
  editingId: string | null;
  gridMinWidth: number;
  density: 'comfortable' | 'compact';
  uiScale: number;
  clipboard: { mode: 'copy' | 'cut'; files: FileEntry[] } | null;
  confirmBeforeDelete: boolean;
  setConfirmBeforeDelete: (v: boolean) => void;
  setEditingId: (id: string | null) => void;
  setDraftNew: (draft: DraftNew | null) => void;
  setFiles: (files: FileEntry[]) => void;
};

const mocks = vi.hoisted(() => ({
  archiveActionFiles: [] as FileEntry[],
  batchActionFiles: [] as FileEntry[],
  contextActionFile: null as FileEntry | null,
  contextActionFiles: [] as FileEntry[],
  contextOpenForEmpty: vi.fn(),
  contextOpenForFiles: vi.fn(),
  contextClose: vi.fn(),
  createFolderIn: vi.fn(),
  deleteWithUndo: vi.fn(),
  dragMouseDown: vi.fn(),
  invoke: vi.fn(),
  marqueeMouseDown: vi.fn(),
  pushUndo: vi.fn(),
  renamePath: vi.fn(),
  reportError: vi.fn(),
  virtualColumnCount: 3,
}));

let storeState: StoreState;

vi.mock('../store', () => {
  const useFileStore = (selector?: (state: StoreState) => unknown) => {
    return selector ? selector(storeState) : storeState;
  };
  useFileStore.getState = () => storeState;
  return { useFileStore };
});

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

vi.mock('../undoRedoStore', () => ({
  generateOperationId: () => 'operation-1',
  useUndoRedoStore: {
    getState: () => ({
      push: mocks.pushUndo,
    }),
  },
}));

vi.mock('../hooks/useDragStart', () => ({
  useDragStart: ({ onBeginDrag }: { onBeginDrag?: (file: FileEntry) => void }) => ({
    onMouseDown: (_event: React.MouseEvent, file: FileEntry) => {
      mocks.dragMouseDown(file);
      onBeginDrag?.(file);
    },
  }),
}));

vi.mock('../hooks/useVirtualGrid', () => ({
  useVirtualGrid: ({ count }: { count: number }) => {
    if (count === 0) {
      return {
        totalHeight: 0,
        columnCount: mocks.virtualColumnCount,
        virtualRows: [],
        getRowItems: () => [],
      };
    }
    const rowCount = Math.ceil(count / mocks.virtualColumnCount);
    return {
      totalHeight: rowCount * 100,
      columnCount: mocks.virtualColumnCount,
      virtualRows: Array.from({ length: rowCount }, (_, index) => ({
        index,
        start: index * 100,
        size: 100,
      })),
      getRowItems: (rowIndex: number) => {
        const start = rowIndex * mocks.virtualColumnCount;
        return Array.from(
          { length: mocks.virtualColumnCount },
          (_, offset) => start + offset
        ).filter((index) => index < count);
      },
    };
  },
}));

vi.mock('../hooks/useMarqueeSelection', () => ({
  useMarqueeSelection: () => ({
    isActive: false,
    rect: null,
    onMouseDown: mocks.marqueeMouseDown,
  }),
}));

vi.mock('./ContextMenu', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ContextMenu: ({
      onBatchRename,
      onCompress,
      onDeleteConfirm,
      onExtract,
      onRefresh,
      onRename,
    }: {
      onBatchRename: (files: FileEntry[]) => void;
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
          { type: 'button', onClick: () => onRename(mocks.contextActionFile!) },
          'Mock rename action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onBatchRename(mocks.batchActionFiles) },
          'Mock batch action'
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
          { type: 'button', onClick: () => onExtract(mocks.contextActionFile!) },
          'Mock extract action'
        ),
        ReactActual.createElement(
          'button',
          { type: 'button', onClick: () => onRefresh() },
          'Mock refresh action'
        )
      ),
    useContextMenu: () => ({
      state: { open: false },
      openForEmpty: mocks.contextOpenForEmpty,
      openForFiles: mocks.contextOpenForFiles,
      close: mocks.contextClose,
    }),
  };
});

vi.mock('./BatchRenameDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    BatchRenameDialog: ({
      files,
      onApply,
      onClose,
      open,
    }: {
      files: FileEntry[];
      onApply: (renames: { oldPath: string; newName: string }[]) => Promise<void>;
      onClose: () => void;
      open: boolean;
    }) =>
      open
        ? ReactActual.createElement(
            'div',
            { 'data-testid': 'batch-dialog' },
            files.map((file) =>
              ReactActual.createElement('span', { key: file.id }, file.name ?? file.path)
            ),
            ReactActual.createElement(
              'button',
              {
                type: 'button',
                onClick: () => onApply([{ oldPath: files[0].path, newName: 'renamed.txt' }]),
              },
              'Mock apply batch'
            ),
            ReactActual.createElement(
              'button',
              { type: 'button', onClick: onClose },
              'Mock close batch'
            )
          )
        : null,
  };
});

vi.mock('./ArchiveDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  return {
    ArchiveDialog: ({
      mode,
      onClose,
      onSuccess,
      open,
    }: {
      mode: 'compress' | 'extract';
      onClose: () => void;
      onSuccess: () => Promise<void>;
      open: boolean;
    }) =>
      open
        ? ReactActual.createElement(
            'div',
            { 'data-testid': 'archive-dialog' },
            ReactActual.createElement('span', null, `Archive mode: ${mode}`),
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
              { type: 'button', onClick: () => onConfirm(false) },
              'Mock trash delete'
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

function makeFile(overrides: Partial<FileEntry> & Pick<FileEntry, 'id' | 'path'>): FileEntry {
  return {
    id: overrides.id,
    path: overrides.path,
    name: overrides.name,
    size: overrides.size ?? 128,
    modified: overrides.modified ?? '2026-01-01T00:00:00.000Z',
    hidden: overrides.hidden,
    is_dir: overrides.is_dir ?? false,
    custom: overrides.custom ?? {},
    is_draft: overrides.is_draft,
  };
}

function getGridContainer(container: HTMLElement): HTMLElement {
  const grid = container.querySelector('div[tabindex="0"]');
  if (!grid) throw new Error('Grid container not found');
  return grid as HTMLElement;
}

describe('GridView', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.archiveActionFiles = [];
    mocks.batchActionFiles = [];
    mocks.contextActionFile = null;
    mocks.contextActionFiles = [];
    mocks.virtualColumnCount = 3;
    mocks.createFolderIn.mockReset();
    mocks.createFolderIn.mockResolvedValue('/root/New Folder');
    mocks.deleteWithUndo.mockReset();
    mocks.deleteWithUndo.mockResolvedValue(true);
    mocks.dragMouseDown.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
    mocks.marqueeMouseDown.mockReset();
    mocks.pushUndo.mockReset();
    mocks.renamePath.mockReset();
    mocks.renamePath.mockResolvedValue('/root/renamed.txt');
    mocks.reportError.mockReset();
    mocks.contextOpenForEmpty.mockReset();
    mocks.contextOpenForFiles.mockReset();
    mocks.contextClose.mockReset();

    storeState = {
      showHidden: false,
      sortKey: 'name',
      sortDir: 'asc',
      filterMode: 'all',
      searchQuery: '',
      draftNew: null,
      editingId: null,
      gridMinWidth: 140,
      density: 'comfortable',
      uiScale: 1,
      clipboard: null,
      confirmBeforeDelete: true,
      setConfirmBeforeDelete: vi.fn(),
      setEditingId: vi.fn(),
      setDraftNew: vi.fn(),
      setFiles: vi.fn(),
    };
  });

  it('renders empty state when no files are visible', () => {
    render(<GridView currentPath="/root" files={[]} />);
    expect(screen.getByText('This folder is empty')).toBeInTheDocument();
  });

  it('renders file names, derived basenames, and formatted sizes', () => {
    render(
      <GridView
        currentPath="/root"
        files={[makeFile({ id: 'file-1', path: '/root/hello.txt', size: 2048 })]}
      />
    );

    expect(screen.getByText('hello.txt')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByLabelText('Select file hello.txt')).toBeInTheDocument();
  });

  it('filters hidden entries, folder mode, search results, and injects a matching draft folder', () => {
    storeState.filterMode = 'folders';
    storeState.searchQuery = 'project';
    storeState.draftNew = { id: 'draft-folder', parentPath: '/root', name: 'New Folder' };
    const files = [
      makeFile({ id: 'hidden-folder', path: '/root/.project-cache', hidden: true, is_dir: true }),
      makeFile({ id: 'project-file', path: '/root/project.txt', is_dir: false }),
      makeFile({ id: 'project-folder', path: '/root/Project Folder', is_dir: true }),
      makeFile({ id: 'other-folder', path: '/root/Downloads', is_dir: true }),
    ];

    render(<GridView currentPath="/root" files={files} />);

    expect(screen.getByText('New Folder')).toBeInTheDocument();
    expect(screen.getByText('Project Folder')).toBeInTheDocument();
    expect(screen.queryByText('.project-cache')).not.toBeInTheDocument();
    expect(screen.queryByText('project.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('Downloads')).not.toBeInTheDocument();
  });

  it('selects, toggles, ranges, clears, and exposes selected files for keyboard clipboard shortcuts', async () => {
    const getSelectedFilesRef = React.createRef<(() => FileEntry[]) | null>();
    const onFileSelect = vi.fn();
    const files = [
      makeFile({ id: 'a', path: '/root/a.txt' }),
      makeFile({ id: 'b', path: '/root/b.txt' }),
      makeFile({ id: 'c', path: '/root/c.txt' }),
    ];

    render(
      <GridView
        currentPath="/root"
        files={files}
        onFileSelect={onFileSelect}
        getSelectedFilesRef={getSelectedFilesRef}
      />
    );

    fireEvent.click(screen.getByLabelText('Select file a.txt'));
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a'])
    );
    expect(onFileSelect).toHaveBeenLastCalledWith(files[0]);

    fireEvent.click(screen.getByLabelText('Select file c.txt'), { shiftKey: true });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a', 'b', 'c'])
    );

    fireEvent.click(screen.getByLabelText('Select file b.txt'), { ctrlKey: true });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a', 'c'])
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(getSelectedFilesRef.current?.()).toEqual([]));
  });

  it('handles grid keyboard shortcuts for select all, arrow movement, range extension, rename, and clear', async () => {
    mocks.virtualColumnCount = 2;
    const { container } = render(
      <GridView
        currentPath="/root"
        files={[
          makeFile({ id: 'a', path: '/root/a.txt' }),
          makeFile({ id: 'b', path: '/root/b.txt' }),
          makeFile({ id: 'c', path: '/root/c.txt' }),
        ]}
      />
    );
    const grid = getGridContainer(container);

    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid, { key: 'F2' });
    expect(storeState.setEditingId).toHaveBeenCalledWith('b');

    fireEvent.keyDown(grid, { key: 'Escape' });
    fireEvent.keyDown(grid, { key: 'F2' });
    expect(storeState.setEditingId).toHaveBeenCalledTimes(1);
  });

  it('opens folders through double click and opens files through keyboard and double click invoke', () => {
    const onFolderOpen = vi.fn();
    const files = [
      makeFile({ id: 'folder', path: '/root/Projects', is_dir: true }),
      makeFile({ id: 'file', path: '/root/notes.md', is_dir: false }),
    ];

    render(<GridView currentPath="/root" files={files} onFolderOpen={onFolderOpen} />);

    fireEvent.doubleClick(screen.getByLabelText('Open folder Projects'));
    expect(onFolderOpen).toHaveBeenCalledWith(files[0]);

    fireEvent.keyDown(screen.getByLabelText('Select file notes.md'), { key: 'Enter' });
    fireEvent.doubleClick(screen.getByLabelText('Select file notes.md'));
    expect(invoke).toHaveBeenCalledWith('open_path', { path: '/root/notes.md' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('commits inline rename for existing files and refreshes the file list with display names', async () => {
    storeState.editingId = 'file';
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'file', path: '/root/renamed.txt', size: 64, name: undefined }),
    ]);

    render(
      <GridView
        currentPath="/root"
        files={[makeFile({ id: 'file', path: '/root/original.txt', is_dir: false })]}
      />
    );

    const input = screen.getByDisplayValue('original.txt');
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.renamePath).toHaveBeenCalledWith('/root/original.txt', 'renamed.txt')
    );
    expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
      path: '/root',
      calc_dir_size: false,
    });
    expect(storeState.setFiles).toHaveBeenCalledWith([
      expect.objectContaining({ path: '/root/renamed.txt', name: 'renamed.txt' }),
    ]);
    expect(storeState.setEditingId).toHaveBeenLastCalledWith(null);
  });

  it('creates draft folders on inline rename commit and cancels blank draft names', async () => {
    storeState.draftNew = { id: 'draft-blank', parentPath: '/root', name: 'Untitled Folder' };
    storeState.editingId = 'draft-blank';

    const { rerender } = render(<GridView currentPath="/root" files={[]} />);
    const input = screen.getByDisplayValue('Untitled Folder');
    fireEvent.change(input, { target: { value: 'Project Docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.createFolderIn).toHaveBeenCalledWith('/root', 'Project Docs'));
    expect(storeState.setDraftNew).toHaveBeenCalledWith(null);

    vi.mocked(storeState.setDraftNew).mockClear();
    storeState.draftNew = { id: 'draft', parentPath: '/root', name: 'Untitled Folder' };
    storeState.editingId = 'draft';
    rerender(<GridView currentPath="/root" files={[]} />);
    const blankInput = screen.getByDisplayValue('Untitled Folder');
    fireEvent.change(blankInput, { target: { value: '   ' } });
    fireEvent.keyDown(blankInput, { key: 'Enter' });

    expect(storeState.setDraftNew).toHaveBeenCalledWith(null);
  });

  it('opens context menus for selected files and for empty space when clipboard data exists', async () => {
    storeState.clipboard = { mode: 'copy', files: [] };
    const files = [
      makeFile({ id: 'a', path: '/root/a.txt' }),
      makeFile({ id: 'b', path: '/root/b.txt' }),
    ];
    const { container } = render(<GridView currentPath="/root" files={files} />);

    fireEvent.click(screen.getByLabelText('Select file a.txt'));
    fireEvent.click(screen.getByLabelText('Select file b.txt'), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByLabelText('Select file b.txt'));
    await waitFor(() =>
      expect(mocks.contextOpenForFiles).toHaveBeenCalledWith(
        expect.any(Object),
        [files[0], files[1]],
        '/root'
      )
    );

    fireEvent.contextMenu(getGridContainer(container));
    expect(mocks.contextOpenForEmpty).toHaveBeenCalledWith(expect.any(Object), '/root');
  });

  it('drives delete confirmation from context actions and honors the do-not-ask flag', async () => {
    const files = [makeFile({ id: 'a', path: '/root/a.txt' })];
    mocks.contextActionFiles = files;

    render(<GridView currentPath="/root" files={files} />);
    fireEvent.click(screen.getByText('Mock delete action'));

    expect(await screen.findByTestId('delete-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock do not ask'));
    expect(storeState.setConfirmBeforeDelete).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('Mock permanent delete'));
    await waitFor(() =>
      expect(mocks.deleteWithUndo).toHaveBeenCalledWith(
        files,
        expect.any(Function),
        expect.any(Function),
        { permanent: true }
      )
    );
  });

  it('applies batch rename from context actions, records undo metadata, and refreshes files', async () => {
    const files = [makeFile({ id: 'a', path: '/root/a.txt', name: 'a.txt' })];
    mocks.batchActionFiles = files;
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'a', path: '/root/renamed.txt', name: undefined }),
    ]);

    render(<GridView currentPath="/root" files={files} />);
    fireEvent.click(screen.getByText('Mock batch action'));
    expect(await screen.findByTestId('batch-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock apply batch'));

    await waitFor(() =>
      expect(mocks.renamePath).toHaveBeenCalledWith('/root/a.txt', 'renamed.txt')
    );
    expect(mocks.pushUndo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'operation-1',
        type: 'batch_rename',
        description: 'Renamed 1 file',
        successCount: 1,
      })
    );
    expect(storeState.setFiles).toHaveBeenCalledWith([
      expect.objectContaining({ path: '/root/renamed.txt', name: 'renamed.txt' }),
    ]);
  });

  it('opens archive dialogs for compress and extract actions and refreshes after success', async () => {
    const files = [
      makeFile({ id: 'archive', path: '/root/archive.zip' }),
      makeFile({ id: 'file', path: '/root/file.txt' }),
    ];
    mocks.archiveActionFiles = [files[1]];
    mocks.contextActionFile = files[0];
    mocks.invoke.mockResolvedValue([
      makeFile({ id: 'new', path: '/root/new.txt', name: undefined }),
    ]);

    render(<GridView currentPath="/root" files={files} />);
    fireEvent.click(screen.getByText('Mock compress action'));
    expect(await screen.findByText('Archive mode: compress')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock archive success'));

    await waitFor(() => expect(storeState.setFiles).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Mock extract action'));
    expect(await screen.findByText('Archive mode: extract')).toBeInTheDocument();
  });

  it('reports delete failures and refreshes files from context refresh actions', async () => {
    const files = [makeFile({ id: 'a', path: '/root/a.txt' })];
    mocks.contextActionFiles = files;
    mocks.deleteWithUndo.mockRejectedValueOnce(new Error('delete failed'));
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'fresh', path: '/root/fresh.txt', name: undefined }),
    ]);

    render(<GridView currentPath="/root" files={files} />);
    fireEvent.click(screen.getByText('Mock delete action'));
    fireEvent.click(await screen.findByText('Mock trash delete'));

    await waitFor(() =>
      expect(mocks.reportError).toHaveBeenCalledWith(
        'Delete failed',
        expect.any(Error),
        expect.any(Object)
      )
    );

    fireEvent.click(screen.getByText('Mock refresh action'));
    await waitFor(() =>
      expect(storeState.setFiles).toHaveBeenCalledWith([
        expect.objectContaining({ path: '/root/fresh.txt', name: 'fresh.txt' }),
      ])
    );
  });

  it('handles drag start, folder hover targets, container hover, and empty-space marquee start', () => {
    const onBeginDrag = vi.fn();
    const onHoverFolder = vi.fn();
    const onHoverContainer = vi.fn();
    const files = [
      makeFile({ id: 'folder', path: '/root/Folder', is_dir: true }),
      makeFile({ id: 'file', path: '/root/file.txt', is_dir: false }),
    ];
    const { container } = render(
      <GridView
        currentPath="/root"
        files={files}
        isDragging
        draggingItemId="file"
        onBeginDrag={onBeginDrag}
        onHoverFolder={onHoverFolder}
        onHoverContainer={onHoverContainer}
      />
    );

    fireEvent.mouseDown(screen.getByLabelText('Open folder Folder'));
    expect(mocks.dragMouseDown).toHaveBeenCalledWith(files[0]);
    expect(onBeginDrag).toHaveBeenCalledWith(files[0]);

    fireEvent.mouseEnter(getGridContainer(container));
    expect(onHoverContainer).toHaveBeenCalledWith('/root');

    fireEvent.mouseEnter(screen.getByLabelText('Open folder Folder'));
    expect(onHoverFolder).toHaveBeenLastCalledWith(files[0]);
    fireEvent.mouseEnter(screen.getByLabelText('Select file file.txt'));
    expect(onHoverFolder).toHaveBeenLastCalledWith(null);

    fireEvent.mouseDown(getGridContainer(container), { button: 0 });
    expect(mocks.marqueeMouseDown).toHaveBeenCalled();
    expect(onHoverFolder).toHaveBeenLastCalledWith(null);
  });
});
