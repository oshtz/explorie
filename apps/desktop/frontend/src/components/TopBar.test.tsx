import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { useFileStore } from '../store';
import { invoke } from '@tauri-apps/api/core';
import { createNoteIn, createWebsiteLinkIn } from '../utils/fs';

const showToast = vi.fn();

vi.mock('./Toast', () => ({
  useToast: () => ({
    show: showToast,
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

vi.mock('../utils/fs', async () => {
  const actual = await vi.importActual<typeof import('../utils/fs')>('../utils/fs');
  return {
    ...actual,
    createNoteIn: vi.fn(async () => '/root/New Note.md'),
    createWebsiteLinkIn: vi.fn(async () => '/root/New Website.url'),
  };
});

type TopBarProps = React.ComponentProps<typeof TopBar>;

function renderTopBar(overrides: Partial<TopBarProps> = {}) {
  const props: TopBarProps = {
    currentPath: '/root',
    viewMode: 'list',
    setViewMode: vi.fn(),
    canGoBack: true,
    canGoForward: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onUp: vi.fn(),
    onNavigate: vi.fn(),
    backHistory: ['/root/projects'],
    forwardHistory: [],
    onBackHistorySelect: vi.fn(),
    ...overrides,
  };

  const view = render(
    <TopBar
      currentPath={props.currentPath}
      viewMode={props.viewMode}
      setViewMode={props.setViewMode}
      canGoBack={props.canGoBack}
      canGoForward={props.canGoForward}
      onBack={props.onBack}
      onForward={props.onForward}
      onUp={props.onUp}
      onNavigate={props.onNavigate}
      backHistory={props.backHistory}
      forwardHistory={props.forwardHistory}
      onBackHistorySelect={props.onBackHistorySelect}
      onForwardHistorySelect={props.onForwardHistorySelect}
    />
  );
  return { ...view, props };
}

describe('TopBar', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useFileStore.setState({
      files: [],
      viewMode: 'list',
      theme: 'dark',
      showHidden: false,
      showPreviewPanel: false,
      showFolderSizes: false,
      sortKey: 'name',
      sortDir: 'asc',
      filterMode: 'all',
      searchQuery: '',
      pathStack: ['/root'],
      editingId: null,
      draftNew: null,
      smartFolders: {},
      activeSmartFolderId: null,
      gridMinWidth: 140,
    });
    vi.mocked(invoke).mockResolvedValue([]);
  });

  it('saves the current search as a smart folder', async () => {
    const user = userEvent.setup();

    renderTopBar();

    const searchInput = screen.getByRole('textbox', { name: /search files and folders/i });
    await user.type(searchInput, 'manifest');
    await user.click(screen.getByRole('button', { name: /save search as smart folder/i }));
    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(nameInput);
    await user.type(nameInput, 'Manifest Search');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const smartFolders = useFileStore.getState().getSmartFolderList();
    expect(smartFolders).toHaveLength(1);
    expect(smartFolders[0]).toMatchObject({
      name: 'Manifest Search',
      criteria: {
        namePattern: 'manifest',
        searchPaths: ['/root'],
        recursive: true,
        typeFilter: 'all',
      },
    });
    expect(showToast).toHaveBeenCalledWith('Smart folder saved: Manifest Search', {
      type: 'success',
    });
  });

  it('updates view, filter, and display toggles from popovers', async () => {
    const user = userEvent.setup();

    renderTopBar();

    await user.click(screen.getByRole('button', { name: /change view mode/i }));
    await user.click(screen.getByRole('button', { name: /grid/i }));
    expect(useFileStore.getState().viewMode).toBe('grid');

    await user.click(screen.getByRole('button', { name: /filter options/i }));
    await user.click(screen.getByRole('button', { name: /files/i }));
    expect(useFileStore.getState().filterMode).toBe('files');

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(screen.getByRole('button', { name: /show folder sizes/i }));
    await waitFor(() => expect(useFileStore.getState().showFolderSizes).toBe(true));
  });

  it('closes an open popover with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    renderTopBar();

    const viewButton = screen.getByRole('button', { name: /change view mode/i });
    await user.click(viewButton);
    expect(screen.getByRole('group', { name: /view options/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /view options/i })).not.toBeInTheDocument();
    expect(viewButton).toHaveFocus();
  });

  it('runs navigation controls and selects history entries from context menus', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onForward = vi.fn();
    const onUp = vi.fn();
    const onBackHistorySelect = vi.fn();
    const onForwardHistorySelect = vi.fn();

    renderTopBar({
      canGoBack: true,
      canGoForward: true,
      onBack,
      onForward,
      onUp,
      backHistory: ['/root/alpha', '/root/beta'],
      forwardHistory: ['/root/gamma', '/root/delta'],
      onBackHistorySelect,
      onForwardHistorySelect,
    });

    await user.click(screen.getByRole('button', { name: /go back/i }));
    await user.click(screen.getByRole('button', { name: /go forward/i }));
    await user.click(screen.getByRole('button', { name: /go to parent folder/i }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onUp).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByRole('button', { name: /go back/i }));
    await user.click(screen.getByRole('button', { name: /go back to beta/i }));
    expect(onBackHistorySelect).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('group', { name: /navigation history/i })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole('button', { name: /go forward/i }));
    await user.click(screen.getByRole('button', { name: /go forward to delta/i }));
    expect(onForwardHistorySelect).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('group', { name: /forward history/i })).not.toBeInTheDocument();
  });

  it('starts an inline folder draft from the create menu', async () => {
    const user = userEvent.setup();
    vi.spyOn(Date, 'now').mockReturnValue(12345);

    renderTopBar();

    await user.click(screen.getByRole('button', { name: /create new item/i }));
    await user.click(screen.getByRole('button', { name: /new folder/i }));

    expect(useFileStore.getState().draftNew).toEqual({
      id: 'draft:12345',
      parentPath: '/root',
      name: 'New Folder',
    });
    expect(useFileStore.getState().editingId).toBe('draft:12345');
    expect(screen.queryByRole('group', { name: /create options/i })).not.toBeInTheDocument();
  });

  it('creates notes and website links then refreshes the current folder', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue([
      {
        id: 'created',
        path: '/root/New Note.md',
        size: 12,
        modified: 1,
        is_dir: false,
        custom: {},
      },
    ]);
    renderTopBar();

    await user.click(screen.getByRole('button', { name: /create new item/i }));
    await user.click(screen.getByRole('button', { name: /new note/i }));

    expect(createNoteIn).toHaveBeenCalledWith('/root');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('list_files', {
        path: '/root',
        calc_dir_size: false,
      })
    );
    expect(useFileStore.getState().files).toEqual([
      expect.objectContaining({ id: 'created', name: 'New Note.md' }),
    ]);

    await user.click(screen.getByRole('button', { name: /create new item/i }));
    await user.click(screen.getByRole('button', { name: /new website link/i }));
    const urlInput = screen.getByRole('textbox', { name: 'Website URL' });
    await user.clear(urlInput);
    await user.type(urlInput, 'https://example.com');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createWebsiteLinkIn).toHaveBeenCalledWith('/root', 'https://example.com')
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  });

  it('updates sort, theme, hidden files, and clears search from keyboard', async () => {
    const user = userEvent.setup();

    renderTopBar();

    const searchInput = screen.getByRole('textbox', { name: /search files and folders/i });
    await user.type(searchInput, 'draft');
    expect(searchInput).toHaveValue('draft');
    await user.keyboard('{Escape}');
    expect(searchInput).toHaveValue('');
    expect(useFileStore.getState().searchQuery).toBe('');

    await user.click(screen.getByRole('button', { name: /sort options/i }));
    await user.click(screen.getByRole('button', { name: /size/i }));
    expect(useFileStore.getState().sortKey).toBe('size');
    expect(useFileStore.getState().sortDir).toBe('asc');

    await user.click(screen.getByRole('button', { name: /sort options/i }));
    await user.click(screen.getByRole('button', { name: /size/i }));
    expect(useFileStore.getState().sortDir).toBe('desc');

    await user.click(screen.getByRole('button', { name: /change view mode/i }));
    await user.click(screen.getByRole('button', { name: /show hidden files/i }));
    expect(useFileStore.getState().showHidden).toBe(true);

    await user.click(screen.getByRole('button', { name: /more options/i }));
    await user.click(screen.getByRole('button', { name: /use light theme/i }));
    expect(useFileStore.getState().theme).toBe('light');
  });

  it('renders the plain folder name and disables up navigation at filesystem roots', () => {
    renderTopBar({
      currentPath: '/',
      canGoBack: false,
      onNavigate: undefined,
    });

    expect(screen.getByText('/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /go to parent folder/i })).toBeDisabled();
  });

  it('recognizes Syncthing folders and conflict copies', async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'get_syncthing_root' ? '/root' : []
    );
    useFileStore.setState({
      files: [
        {
          id: 'conflict',
          path: '/root/report.sync-conflict-20260711-120000.md',
          name: 'report.sync-conflict-20260711-120000.md',
          size: 1,
          modified: 1,
          is_dir: false,
          custom: {},
        },
      ],
    });

    renderTopBar();

    expect(await screen.findByText('Syncthing · 1 conflict')).toHaveAttribute(
      'title',
      'Synced by Syncthing: /root'
    );
  });
});
