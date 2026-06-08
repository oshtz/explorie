import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const mockRefreshDefaultExplorer = vi.fn(async () => null);
const mockMakeDefaultExplorer = vi.fn(async () => {});
const mockClearDefaultExplorerError = vi.fn();

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
      defaultExplorerSupported: false,
      defaultExplorerEnabled: null,
      defaultExplorerLoading: false,
      defaultExplorerError: null,
      refreshDefaultExplorer: mockRefreshDefaultExplorer,
      makeDefaultExplorer: mockMakeDefaultExplorer,
      clearDefaultExplorerError: mockClearDefaultExplorerError,
      favorites: favoritesData,
      removeFavorite: mockRemoveFavorite,
      reorderFavorites: mockReorderFavorites,
      renameFavorite: mockRenameFavorite,
      smartFolders: smartFoldersData,
      deleteSmartFolder: mockDeleteSmartFolder,
      setSearchQuery: mockSetSearchQuery,
      setFilterMode: mockSetFilterMode,
      setActiveSmartFolderId: mockSetActiveSmartFolderId,
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

  it('activates smart folder on click', async () => {
    render(<Sidebar recents={[]} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());

    // Find and click the smart folder button using fireEvent for reliability
    const smartFolderButtons = await screen.findAllByLabelText('Open Recent Text');
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
