import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

// Create mock functions at module level so they persist
const mockSetActiveSmartFolderId = vi.fn();
const mockSetSearchQuery = vi.fn();
const mockSetFilterMode = vi.fn();
const mockSetViewMode = vi.fn();
const mockDeleteSmartFolder = vi.fn();
const mockRemoveFavorite = vi.fn();
const mockReorderFavorites = vi.fn();
const mockRenameFavorite = vi.fn();
const smartFoldersData = {
  sf1: {
    id: 'sf1',
    name: 'Recent Text',
    criteria: { searchPaths: ['/root'], namePattern: 'readme', typeFilter: 'files' as const },
    createdAt: 1,
    updatedAt: 1,
  },
};

const favoritesData = [
  { path: '/root/docs', name: 'Docs' },
  { path: '/root/pics', name: 'Pics' },
];

const invokeMock = vi.fn();

vi.mock('../store', () => ({
  useFileStore: (selector?: (state: any) => any) => {
    const state = {
      favorites: favoritesData,
      removeFavorite: mockRemoveFavorite,
      reorderFavorites: mockReorderFavorites,
      renameFavorite: mockRenameFavorite,
      smartFolders: smartFoldersData,
      deleteSmartFolder: mockDeleteSmartFolder,
      setSearchQuery: mockSetSearchQuery,
      setFilterMode: mockSetFilterMode,
      setActiveSmartFolderId: mockSetActiveSmartFolderId,
      activeSmartFolderId: 'sf1',
      setViewMode: mockSetViewMode,
    };
    if (selector) {
      return selector(state);
    }
    return state;
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string) => invokeMock(command),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    // Clear all mock call history
    vi.clearAllMocks();

    invokeMock.mockResolvedValue({
      desktop: '/root/Desktop',
      documents: '/root/Documents',
      downloads: '/root/Downloads',
      pictures: '/root/Pictures',
      music: '/root/Music',
      videos: '/root/Videos',
      home: '/root',
      drives: ['/root'],
    });
  });

  afterEach(cleanup);

  it('invokes navigation and settings callbacks', async () => {
    const user = userEvent.setup();
    const onSelectLocation = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <Sidebar
        recents={['/root/docs']}
        onSelectLocation={onSelectLocation}
        onOpenSettings={onOpenSettings}
      />
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());

    await user.click(screen.getByLabelText('Go to Docs'));
    expect(onSelectLocation).toHaveBeenCalledWith('/root/docs');

    await user.click(screen.getByRole('button', { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('reorders user favorites by drag and drop', async () => {
    render(<Sidebar recents={[]} />);
    const docs = screen.getByLabelText('Go to Docs').closest('[draggable="true"]');
    const pics = screen.getByLabelText('Go to Pics').closest('[draggable="true"]');
    const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };

    expect(docs).not.toBeNull();
    expect(pics).not.toBeNull();
    fireEvent.dragStart(docs!, { dataTransfer });
    fireEvent.dragOver(pics!, { dataTransfer });
    fireEvent.drop(pics!, { dataTransfer });

    expect(mockReorderFavorites).toHaveBeenCalledWith([favoritesData[1], favoritesData[0]]);
  });

  it('reorders favorites from the keyboard and exposes folder pin drops', async () => {
    const onFileDragHoverFavorites = vi.fn();
    render(
      <Sidebar recents={[]} fileDragActive onFileDragHoverFavorites={onFileDragHoverFavorites} />
    );

    const docs = await screen.findByLabelText('Go to Docs');
    fireEvent.keyDown(docs, { key: 'ArrowDown', altKey: true });
    expect(mockReorderFavorites).toHaveBeenCalledWith([favoritesData[1], favoritesData[0]]);

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Favorites' }));
    expect(onFileDragHoverFavorites).toHaveBeenCalledOnce();
  });

  it('marks the current location after normalizing path separators', async () => {
    render(<Sidebar recents={[]} currentPath="/root/Documents/" />);

    const documents = await screen.findByLabelText('Go to Documents');
    expect(documents).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('Go to Desktop')).not.toHaveAttribute('aria-current');
  });

  it('shows a retryable error when system locations fail to load', async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) =>
      command === 'list_system_locations'
        ? Promise.reject(new Error('unavailable'))
        : Promise.resolve({})
    );
    render(<Sidebar recents={[]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Locations unavailable');

    invokeMock.mockResolvedValue({
      desktop: '/root/Desktop',
      documents: '/root/Documents',
      downloads: '/root/Downloads',
      pictures: '/root/Pictures',
      music: '/root/Music',
      videos: '/root/Videos',
      home: '/root',
      drives: ['/root'],
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByLabelText('Go to Desktop')).length).toBeGreaterThan(0);
  });

  it('activates smart folder on click', async () => {
    render(<Sidebar recents={[]} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());

    // Find and click the smart folder button using fireEvent for reliability
    const smartFolderButtons = await screen.findAllByLabelText('Open Recent Text');
    expect(smartFolderButtons[0]).toHaveAttribute('aria-current', 'page');
    fireEvent.click(smartFolderButtons[0]);

    // Verify that the store functions are called with correct arguments
    await waitFor(() => {
      expect(mockSetActiveSmartFolderId).toHaveBeenCalledWith('sf1');
      expect(mockSetViewMode).toHaveBeenCalledWith('list');
      expect(mockSetSearchQuery).toHaveBeenCalledWith('readme');
      expect(mockSetFilterMode).toHaveBeenCalledWith('files');
    });
  });
});
