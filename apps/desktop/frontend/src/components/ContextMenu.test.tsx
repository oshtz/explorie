import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { ContextMenu, type ContextMenuState } from './ContextMenu';

type ClipboardState = {
  mode: 'copy' | 'cut';
  items: FileEntry[];
  sourcePath: string;
} | null;

type StoreState = {
  clipboard: ClipboardState;
  favorites: Array<{ path: string; name: string }>;
  setClipboard: ReturnType<typeof vi.fn>;
  addFavorite: ReturnType<typeof vi.fn>;
  removeFavorite: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  storeState: {
    clipboard: null,
    favorites: [],
    setClipboard: vi.fn(),
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
  } as StoreState,
  showToast: vi.fn(),
  deleteWithUndo: vi.fn(),
  moveWithUndoAndConflictResolution: vi.fn(),
  copyWithUndoAndConflictResolution: vi.fn(),
  deletePath: vi.fn(),
  copyPathToDir: vi.fn(),
  moveToFolder: vi.fn(),
  reportError: vi.fn(),
  revealInFileManager: vi.fn(),
  quickLook: vi.fn(),
  isQuickLookAvailable: vi.fn(),
  isOpenWithAvailable: vi.fn(),
  getAppsForFile: vi.fn(),
  openWithApp: vi.fn(),
}));

vi.mock('../store', () => ({
  useFileStore: (selector: (state: StoreState) => unknown) => selector(mocks.storeState),
}));

vi.mock('../operationQueueStore', () => ({
  useOperationQueueStore: {
    getState: () => ({
      defaultConflictResolution: 'rename',
    }),
  },
}));

vi.mock('./Toast', () => ({
  useToast: () => ({
    show: mocks.showToast,
  }),
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

vi.mock('../utils/fileOperations', () => ({
  deleteWithUndo: mocks.deleteWithUndo,
  moveWithUndoAndConflictResolution: mocks.moveWithUndoAndConflictResolution,
  copyWithUndoAndConflictResolution: mocks.copyWithUndoAndConflictResolution,
}));

vi.mock('../utils/fs', () => ({
  deletePath: mocks.deletePath,
  copyPathToDir: mocks.copyPathToDir,
  moveToFolder: mocks.moveToFolder,
}));

vi.mock('../utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('../services/finderIntegration', () => ({
  revealInFileManager: mocks.revealInFileManager,
  quickLook: mocks.quickLook,
  isQuickLookAvailable: mocks.isQuickLookAvailable,
  isOpenWithAvailable: mocks.isOpenWithAvailable,
  getAppsForFile: mocks.getAppsForFile,
  openWithApp: mocks.openWithApp,
}));

function file(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: path,
    path,
    name: path.split('/').pop() ?? path,
    size: 128,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function menuState(overrides: Partial<ContextMenuState> = {}): ContextMenuState {
  return {
    open: true,
    x: 10,
    y: 20,
    files: [file('/workspace/report.txt')],
    containerPath: '/workspace',
    ...overrides,
  };
}

describe('ContextMenu', () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = 'web';
    mocks.storeState.clipboard = null;
    mocks.storeState.favorites = [];
    mocks.storeState.setClipboard.mockReset();
    mocks.storeState.addFavorite.mockReset();
    mocks.storeState.removeFavorite.mockReset();
    mocks.showToast.mockReset();
    mocks.deleteWithUndo.mockReset();
    mocks.deleteWithUndo.mockResolvedValue(undefined);
    mocks.moveWithUndoAndConflictResolution.mockReset();
    mocks.moveWithUndoAndConflictResolution.mockResolvedValue(undefined);
    mocks.copyWithUndoAndConflictResolution.mockReset();
    mocks.copyWithUndoAndConflictResolution.mockResolvedValue(undefined);
    mocks.deletePath.mockReset();
    mocks.copyPathToDir.mockReset();
    mocks.moveToFolder.mockReset();
    mocks.reportError.mockReset();
    mocks.revealInFileManager.mockReset();
    mocks.revealInFileManager.mockResolvedValue(undefined);
    mocks.quickLook.mockReset();
    mocks.quickLook.mockResolvedValue(undefined);
    mocks.isQuickLookAvailable.mockReset();
    mocks.isQuickLookAvailable.mockResolvedValue(false);
    mocks.isOpenWithAvailable.mockReset();
    mocks.isOpenWithAvailable.mockResolvedValue(false);
    mocks.getAppsForFile.mockReset();
    mocks.getAppsForFile.mockResolvedValue([]);
    mocks.openWithApp.mockReset();
    mocks.openWithApp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render when closed or when there is no available action', () => {
    const { rerender } = render(
      <ContextMenu state={menuState({ open: false })} onClose={vi.fn()} />
    );

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(<ContextMenu state={menuState({ files: [] })} onClose={vi.fn()} />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('runs single-file rename, copy, cut, and delete-confirm actions', async () => {
    const user = userEvent.setup();
    const selected = file('/workspace/report.txt');
    const onClose = vi.fn();
    const onRename = vi.fn();
    const onDeleteConfirm = vi.fn();

    render(
      <ContextMenu
        state={menuState({ files: [selected] })}
        onClose={onClose}
        onRename={onRename}
        confirmBeforeDelete
        onDeleteConfirm={onDeleteConfirm}
      />
    );

    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledWith(selected);

    await user.click(screen.getByRole('menuitem', { name: /^Copy/ }));
    expect(mocks.storeState.setClipboard).toHaveBeenCalledWith({
      mode: 'copy',
      items: [selected],
      sourcePath: '/workspace',
    });

    await user.click(screen.getByRole('menuitem', { name: /^Cut/ }));
    expect(mocks.storeState.setClipboard).toHaveBeenCalledWith({
      mode: 'cut',
      items: [selected],
      sourcePath: '/workspace',
    });

    await user.click(screen.getByRole('menuitem', { name: /^Delete/ }));
    expect(onDeleteConfirm).toHaveBeenCalledWith([selected]);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('pastes clipboard items with conflict-aware undo operations', async () => {
    const user = userEvent.setup();
    const copied = file('/source/copy.txt');
    const onRefresh = vi.fn();
    const onClose = vi.fn();
    mocks.storeState.clipboard = {
      mode: 'cut',
      items: [copied],
      sourcePath: '/source',
    };

    render(
      <ContextMenu
        state={menuState({ files: [], containerPath: '/destination' })}
        onClose={onClose}
        onRefresh={onRefresh}
      />
    );

    await user.click(screen.getByRole('menuitem', { name: /^Paste/ }));

    expect(mocks.moveWithUndoAndConflictResolution).toHaveBeenCalledWith(
      [copied],
      '/destination',
      mocks.showToast,
      onRefresh,
      { conflictResolution: 'keepBoth' }
    );
    expect(mocks.storeState.setClipboard).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles favorites for folders with normalized paths', async () => {
    const user = userEvent.setup();
    const folder = file('C:/Users/Dev/Projects', {
      is_dir: true,
      name: 'Projects',
    });
    const onClose = vi.fn();

    const { rerender } = render(
      <ContextMenu state={menuState({ files: [folder] })} onClose={onClose} />
    );

    await user.click(screen.getByRole('menuitem', { name: /Add to Favorites/ }));
    expect(mocks.storeState.addFavorite).toHaveBeenCalledWith('C:/Users/Dev/Projects');

    mocks.storeState.favorites = [{ path: 'C:\\Users\\Dev\\Projects', name: 'Projects' }];
    rerender(<ContextMenu state={menuState({ files: [folder] })} onClose={onClose} />);

    await user.click(screen.getByRole('menuitem', { name: /Remove from Favorites/ }));
    expect(mocks.storeState.removeFavorite).toHaveBeenCalledWith('C:/Users/Dev/Projects');
  });

  it('runs batch rename, archive, and compare actions for multi-selection', async () => {
    const user = userEvent.setup();
    const first = file('/workspace/a.md');
    const second = file('/workspace/b.md');
    const onBatchRename = vi.fn();
    const onCompress = vi.fn();
    const onCompare = vi.fn();

    render(
      <ContextMenu
        state={menuState({ files: [first, second] })}
        onClose={vi.fn()}
        onBatchRename={onBatchRename}
        onCompress={onCompress}
        onCompare={onCompare}
      />
    );

    await user.click(screen.getByRole('menuitem', { name: /Batch Rename \(2\)/ }));
    expect(onBatchRename).toHaveBeenCalledWith([first, second]);

    await user.click(screen.getByRole('menuitem', { name: 'Advanced' }));
    await user.click(screen.getByRole('menuitem', { name: /Compress \(2\)/ }));
    expect(onCompress).toHaveBeenCalledWith([first, second]);

    await user.click(screen.getByRole('menuitem', { name: /Compare Files/ }));
    expect(onCompare).toHaveBeenCalledWith([first, second]);
  });

  it('shows extract and compare-with-marked actions for supported single files', async () => {
    const user = userEvent.setup();
    const archive = file('/workspace/build.zip');
    const current = file('/workspace/current.txt');
    const target = file('/workspace/base.txt');
    const onExtract = vi.fn();
    const onCompare = vi.fn();
    const onSetCompareTarget = vi.fn();

    const { rerender } = render(
      <ContextMenu
        state={menuState({ files: [archive] })}
        onClose={vi.fn()}
        onExtract={onExtract}
      />
    );

    await user.click(screen.getByRole('menuitem', { name: 'Advanced' }));
    await user.click(screen.getByRole('menuitem', { name: /Extract Here/ }));
    expect(onExtract).toHaveBeenCalledWith(archive);

    rerender(
      <ContextMenu
        state={menuState({ files: [current] })}
        onClose={vi.fn()}
        onCompare={onCompare}
        compareTarget={target}
        onSetCompareTarget={onSetCompareTarget}
      />
    );

    await user.click(screen.getByRole('menuitem', { name: 'Advanced' }));
    await user.click(screen.getByRole('menuitem', { name: /Compare with "base.txt"/ }));
    expect(onCompare).toHaveBeenCalledWith([target, current]);
    expect(onSetCompareTarget).toHaveBeenCalledWith(null);
  });

  it('runs native reveal, Quick Look, and Open With actions when available', async () => {
    const user = userEvent.setup();
    const selected = file('/workspace/report.txt');
    mocks.isQuickLookAvailable.mockResolvedValue(true);
    mocks.isOpenWithAvailable.mockResolvedValue(true);
    mocks.getAppsForFile.mockResolvedValue([
      { name: 'Visual Studio Code', path: '/Applications/Code.app' },
    ]);
    document.documentElement.dataset.platform = 'windows';

    render(<ContextMenu state={menuState({ files: [selected] })} onClose={vi.fn()} />);

    await user.click(screen.getByRole('menuitem', { name: 'Show in Explorer' }));
    expect(mocks.revealInFileManager).toHaveBeenCalledWith('/workspace/report.txt');

    await user.click(await screen.findByRole('menuitem', { name: /Quick Look/ }));
    expect(mocks.quickLook).toHaveBeenCalledWith('/workspace/report.txt');

    await user.click(await screen.findByRole('menuitem', { name: /Open With/ }));
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /Visual Studio Code/ })).toBeVisible()
    );
    await user.click(screen.getByRole('menuitem', { name: /Visual Studio Code/ }));

    expect(mocks.getAppsForFile).toHaveBeenCalledWith('/workspace/report.txt');
    expect(mocks.openWithApp).toHaveBeenCalledWith('/workspace/report.txt', 'Visual Studio Code');
  });

  it('clamps to the viewport and restores focus when closed', async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 250 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 160,
      height: 200,
      top: 0,
      right: 160,
      bottom: 200,
      left: 0,
      toJSON: () => ({}),
    });
    const trigger = document.createElement('button');
    document.body.append(trigger);

    const { rerender } = render(
      <ContextMenu state={menuState({ x: 290, y: 240, focusTarget: trigger })} onClose={vi.fn()} />
    );

    const menu = screen.getByRole('menu');
    await waitFor(() => {
      expect(menu).toHaveStyle({ left: '132px', top: '42px' });
    });
    rerender(
      <ContextMenu state={menuState({ open: false, focusTarget: trigger })} onClose={vi.fn()} />
    );
    expect(trigger).toHaveFocus();

    trigger.remove();
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
  });
});
