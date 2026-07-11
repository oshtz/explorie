import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTable, sortFiles } from './FileTable';
import { useFileStore, type FileEntry } from '../store';

const mocks = vi.hoisted(() => ({
  archiveActionFiles: [] as FileEntry[],
  batchActionFiles: [] as FileEntry[],
  contextActionFile: null as FileEntry | null,
  contextActionFiles: [] as FileEntry[],
  contextOpenForEmpty: vi.fn(),
  contextOpenForFiles: vi.fn(),
  deleteWithUndo: vi.fn(),
  createFolderIn: vi.fn(),
  invoke: vi.fn(),
  pushUndo: vi.fn(),
  renamePath: vi.fn(),
  reportError: vi.fn(),
  virtualRowCountOverride: null as number | null,
}));

vi.mock('../hooks/useVirtualRows', () => ({
  useVirtualRows: ({ count, estimateSize = 34 }: { count: number; estimateSize?: number }) => ({
    totalSize: count * estimateSize,
    virtualRows: Array.from({ length: mocks.virtualRowCountOverride ?? count }, (_, index) => ({
      index,
      start: index * estimateSize,
      size: estimateSize,
      key: index,
    })),
  }),
}));

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
      close: vi.fn(),
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
    show: vi.fn(),
  }),
}));

vi.mock('../utils/fs', () => ({
  createFolderIn: mocks.createFolderIn,
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeFile(partial: Partial<FileEntry>): FileEntry {
  return {
    id: 'file-1',
    path: '/root/report.md',
    name: 'report.md',
    size: 2048,
    modified: 0,
    is_dir: false,
    custom: {},
    ...partial,
  };
}

function getTableContainer(container: HTMLElement): HTMLElement {
  const table = container.querySelector('div[tabindex="0"]');
  if (!table) throw new Error('FileTable container not found');
  return table as HTMLElement;
}

describe('FileTable', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.archiveActionFiles = [];
    mocks.batchActionFiles = [];
    mocks.contextActionFile = null;
    mocks.contextActionFiles = [];
    mocks.virtualRowCountOverride = null;
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    mocks.createFolderIn.mockResolvedValue('/root/New Folder');
    mocks.deleteWithUndo.mockResolvedValue(true);
    mocks.invoke.mockResolvedValue([]);
    mocks.renamePath.mockResolvedValue('/root/renamed.txt');
    useFileStore.setState({
      listRowHeight: 34,
      uiScale: 1,
      editingId: null,
      draftNew: null,
      files: [],
      clipboard: null,
      confirmBeforeDelete: true,
    });
  });

  it('sorts drafts first and handles built-in and custom columns', () => {
    const files = [
      makeFile({
        id: 'b',
        path: '/root/b.txt',
        name: 'b.txt',
        size: 300,
        modified: '2026-01-03T00:00:00.000Z',
        custom: { priority: 2, status: 'Todo' },
      }),
      makeFile({
        id: 'draft',
        path: '/root/draft',
        name: 'draft',
        size: 1,
        is_draft: true,
        modified: '2026-01-01T00:00:00.000Z',
        custom: {},
      }),
      makeFile({
        id: 'a',
        path: '/root/a.txt',
        name: 'a.txt',
        size: 100,
        modified: '2026-01-02T00:00:00.000Z',
        custom: { priority: 1, status: 'Done' },
      }),
    ];

    expect(sortFiles(files, 'name', 'asc').map((file) => file.id)).toEqual(['draft', 'a', 'b']);
    expect(sortFiles(files, 'size', 'desc').map((file) => file.id)).toEqual(['draft', 'b', 'a']);
    expect(sortFiles(files, 'modified', 'desc').map((file) => file.id)).toEqual([
      'draft',
      'b',
      'a',
    ]);
    expect(sortFiles(files, 'priority', 'asc').map((file) => file.id)).toEqual(['draft', 'a', 'b']);
    expect(sortFiles(files, 'status', 'desc').map((file) => file.id)).toEqual(['draft', 'b', 'a']);
  });

  it('renders custom metadata columns and inline tag chips', () => {
    const files = [
      makeFile({
        id: 'report',
        path: '/root/report.md',
        name: 'report.md',
        custom: {
          priority: 'High',
          status: 'In Progress',
          tags: ['client', 'review'],
          project: 'Atlas',
        },
      }),
      makeFile({
        id: 'archive',
        path: '/root/archive.zip',
        name: 'archive.zip',
        size: 1024,
        custom: {
          priority: 'Low',
          status: 'Done',
          tags: ['storage'],
        },
      }),
    ];

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    expect(screen.getByRole('columnheader', { name: /priority/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();

    const reportRow = screen.getByRole('row', { name: /file: report\.md/i });
    expect(within(reportRow).getByText('High')).toBeInTheDocument();
    expect(within(reportRow).getByText('In Progress')).toBeInTheDocument();
    expect(within(reportRow).getByLabelText('Tag: client')).toBeInTheDocument();
    expect(within(reportRow).getByLabelText('Tag: review')).toBeInTheDocument();
    expect(within(reportRow).getByLabelText('Tag: Atlas')).toBeInTheDocument();

    const archiveRow = screen.getByRole('row', { name: /file: archive\.zip/i });
    expect(within(archiveRow).getByText('Low')).toBeInTheDocument();
    expect(within(archiveRow).getByText('Done')).toBeInTheDocument();
    expect(within(archiveRow).getByLabelText('Tag: storage')).toBeInTheDocument();
  });

  it('uses keyboard-accessible buttons for sorting', () => {
    const onSort = vi.fn();
    render(
      <FileTable
        droppableId="list:/root"
        files={[makeFile({ id: 'file', path: '/root/file.txt' })]}
        sortKey="name"
        sortDir="asc"
        onSort={onSort}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('ignores stale virtual rows while a file list shrinks', () => {
    mocks.virtualRowCountOverride = 2;

    render(
      <FileTable
        droppableId="list:/root"
        files={[makeFile({ id: 'remaining', path: '/root/remaining.txt', name: 'remaining.txt' })]}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    expect(screen.getByRole('row', { name: /file: remaining\.txt/i })).toBeInTheDocument();
  });

  it('selects, toggles, ranges, clears, and exposes selected files', async () => {
    const getSelectedFilesRef = React.createRef<(() => FileEntry[]) | null>();
    const onFileSelect = vi.fn();
    const files = [
      makeFile({ id: 'a', path: '/root/a.txt', name: 'a.txt' }),
      makeFile({ id: 'b', path: '/root/b.txt', name: 'b.txt' }),
      makeFile({ id: 'c', path: '/root/c.txt', name: 'c.txt' }),
    ];
    const { container } = render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
        onFileSelect={onFileSelect}
        getSelectedFilesRef={getSelectedFilesRef}
      />
    );

    const firstRow = screen.getByRole('row', { name: /file: a\.txt/i });
    const secondRow = screen.getByRole('row', { name: /file: b\.txt/i });
    const thirdRow = screen.getByRole('row', { name: /file: c\.txt/i });
    fireEvent.click(firstRow);
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a'])
    );
    expect(onFileSelect).toHaveBeenLastCalledWith(files[0]);

    fireEvent.click(thirdRow, { shiftKey: true });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a', 'b', 'c'])
    );

    fireEvent.click(secondRow, { ctrlKey: true });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a', 'c'])
    );

    const table = getTableContainer(container);
    fireEvent.keyDown(table, { key: 'a', ctrlKey: true });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a', 'b', 'c'])
    );

    fireEvent.keyDown(table, { key: 'Escape' });
    await waitFor(() => expect(getSelectedFilesRef.current?.()).toEqual([]));

    Object.defineProperty(table, 'clientHeight', { configurable: true, value: 68 });
    fireEvent.keyDown(table, { key: 'End' });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['c'])
    );
    expect(table.scrollTop).toBeGreaterThan(0);

    fireEvent.keyDown(table, { key: 'Home' });
    await waitFor(() =>
      expect(getSelectedFilesRef.current?.().map((file) => file.id)).toEqual(['a'])
    );
    expect(table.scrollTop).toBe(0);
  });

  it('opens folders through double click and opens files through Enter and double click', () => {
    const onFolderOpen = vi.fn();
    const files = [
      makeFile({ id: 'folder', path: '/root/Projects', name: 'Projects', is_dir: true }),
      makeFile({ id: 'file', path: '/root/notes.md', name: 'notes.md', is_dir: false }),
    ];

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
        onFolderOpen={onFolderOpen}
      />
    );

    fireEvent.doubleClick(screen.getByRole('row', { name: /folder: projects/i }));
    expect(onFolderOpen).toHaveBeenCalledWith(files[0]);

    const fileRow = screen.getByRole('row', { name: /file: notes\.md/i });
    fireEvent.keyDown(fileRow, { key: 'Enter' });
    fireEvent.doubleClick(fileRow);
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', { path: '/root/notes.md' });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('reports file-open failures to the user', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('denied'));
    render(
      <FileTable
        droppableId="list:/root"
        files={[makeFile({ id: 'file', path: '/root/notes.md', name: 'notes.md' })]}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    fireEvent.doubleClick(screen.getByRole('row', { name: /file: notes\.md/i }));
    await waitFor(() =>
      expect(mocks.reportError).toHaveBeenCalledWith(
        'Open failed',
        expect.any(Error),
        expect.objectContaining({ context: { path: '/root/notes.md' } })
      )
    );
  });

  it('preserves multi-selection for item context menus and opens empty-space paste', () => {
    useFileStore.setState({ clipboard: { mode: 'copy', items: [], sourcePath: '/root' } });
    const onFileSelect = vi.fn();
    const files = [
      makeFile({ id: 'a', path: '/root/a.txt', name: 'a.txt' }),
      makeFile({ id: 'b', path: '/root/b.txt', name: 'b.txt' }),
      makeFile({ id: 'c', path: '/root/c.txt', name: 'c.txt' }),
    ];
    const { container } = render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
        onFileSelect={onFileSelect}
      />
    );

    fireEvent.click(screen.getByRole('row', { name: /file: a\.txt/i }));
    fireEvent.click(screen.getByRole('row', { name: /file: b\.txt/i }), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByRole('row', { name: /file: b\.txt/i }));
    expect(mocks.contextOpenForFiles).toHaveBeenLastCalledWith(
      expect.any(Object),
      [files[0], files[1]],
      '/root'
    );

    fireEvent.contextMenu(screen.getByRole('row', { name: /file: c\.txt/i }));
    expect(mocks.contextOpenForFiles).toHaveBeenLastCalledWith(
      expect.any(Object),
      [files[2]],
      '/root'
    );
    expect(onFileSelect).toHaveBeenLastCalledWith(files[2]);

    fireEvent.contextMenu(getTableContainer(container));
    expect(mocks.contextOpenForEmpty).toHaveBeenCalledWith(expect.any(Object), '/root');
  });

  it('commits inline rename without bubbling Enter into file open', async () => {
    const files = [makeFile({ id: 'file', path: '/root/original.txt', name: 'original.txt' })];
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'file', path: '/root/renamed.txt', name: undefined }),
    ]);
    useFileStore.setState({ editingId: 'file' });

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    const input = screen.getByLabelText('Rename file');
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.renamePath).toHaveBeenCalledWith('/root/original.txt', 'renamed.txt')
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith('open_path', { path: '/root/original.txt' });
  });

  it('reports rename failures and keeps the original file selected', async () => {
    const file = makeFile({ id: 'file', path: '/root/original.txt', name: 'original.txt' });
    mocks.renamePath.mockRejectedValueOnce(new Error('denied'));
    useFileStore.setState({ editingId: 'file' });

    render(
      <FileTable
        droppableId="list:/root"
        files={[file]}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    const input = screen.getByLabelText('Rename file');
    fireEvent.change(input, { target: { value: 'blocked.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.reportError).toHaveBeenCalledWith(
        'Rename failed',
        expect.any(Error),
        expect.objectContaining({ context: { path: '/root/original.txt' } })
      )
    );
    expect(screen.getByRole('row', { name: /original\.txt, selected/i })).toBeInTheDocument();
  });

  it('creates draft folders from inline rename without opening the draft row', async () => {
    const onFolderOpen = vi.fn();
    const draft = makeFile({
      id: 'draft-folder',
      path: '/root/Untitled Folder',
      name: 'Untitled Folder',
      is_dir: true,
      is_draft: true,
    });
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'created', path: '/root/Project Docs', name: undefined, is_dir: true }),
    ]);
    useFileStore.setState({ editingId: 'draft-folder' });

    render(
      <FileTable
        droppableId="list:/root"
        files={[draft]}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
        onFolderOpen={onFolderOpen}
      />
    );

    const input = screen.getByLabelText('Rename file');
    fireEvent.change(input, { target: { value: 'Project Docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.createFolderIn).toHaveBeenCalledWith('/root', 'Project Docs'));
    expect(onFolderOpen).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
      path: '/root',
      calc_dir_size: false,
    });
  });

  it('drives delete confirmation from context actions and honors do-not-ask', async () => {
    const files = [makeFile({ id: 'a', path: '/root/a.txt', name: 'a.txt' })];
    mocks.contextActionFiles = files;

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Mock delete action'));
    expect(await screen.findByTestId('delete-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Mock do not ask'));
    expect(useFileStore.getState().confirmBeforeDelete).toBe(false);

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

  it('applies batch rename from context actions and records undo metadata', async () => {
    const files = [makeFile({ id: 'a', path: '/root/a.txt', name: 'a.txt' })];
    mocks.batchActionFiles = files;
    mocks.invoke.mockResolvedValueOnce([
      makeFile({ id: 'a', path: '/root/renamed.txt', name: undefined }),
    ]);

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

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
    expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
      path: '/root',
      calc_dir_size: false,
    });
  });

  it('opens archive dialogs and refreshes the table after archive success', async () => {
    const files = [
      makeFile({ id: 'archive', path: '/root/archive.zip', name: 'archive.zip' }),
      makeFile({ id: 'file', path: '/root/file.txt', name: 'file.txt' }),
    ];
    mocks.archiveActionFiles = [files[1]];
    mocks.contextActionFile = files[0];
    mocks.invoke.mockResolvedValue([
      makeFile({ id: 'fresh', path: '/root/fresh.txt', name: undefined }),
    ]);

    render(
      <FileTable
        droppableId="list:/root"
        files={files}
        sortKey="name"
        sortDir="asc"
        onSort={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Mock compress action'));
    expect(await screen.findByText('Archive mode: compress')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Mock archive success'));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('list_files', {
        path: '/root',
        calc_dir_size: false,
      })
    );

    fireEvent.click(screen.getByText('Mock extract action'));
    expect(await screen.findByText('Archive mode: extract')).toBeInTheDocument();
  });
});
