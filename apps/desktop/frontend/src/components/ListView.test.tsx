import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListView } from './ListView';

type StoreState = {
  showHidden: boolean;
  filterMode: 'all' | 'folders' | 'files';
  searchQuery: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  setSort: (key: string) => void;
  showFolderSizes: boolean;
  draftNew: { id: string; parentPath: string; name: string } | null;
};

let storeState: StoreState;
let latestTableProps: any = null;

vi.mock('../store', () => {
  const useFileStore = (selector?: (state: StoreState) => any) => {
    return selector ? selector(storeState) : storeState;
  };
  useFileStore.getState = () => storeState;
  return { useFileStore };
});

vi.mock('./FileTable', () => ({
  FileTable: (props: any) => {
    latestTableProps = props;
    return <div data-testid="file-table" />;
  },
}));

describe('ListView', () => {
  beforeEach(() => {
    storeState = {
      showHidden: false,
      filterMode: 'all',
      searchQuery: '',
      sortKey: 'name',
      sortDir: 'asc',
      setSort: vi.fn(),
      showFolderSizes: false,
      draftNew: null,
    };
    latestTableProps = null;
  });

  it('renders empty state when no files are visible', () => {
    render(<ListView currentPath="/root" files={[]} />);
    expect(screen.getByText('This folder is empty')).toBeInTheDocument();
    expect(screen.getByTestId('file-table')).toBeInTheDocument();
    expect(latestTableProps.files).toEqual([]);
  });

  it('distinguishes filtered results from an empty folder', () => {
    storeState.searchQuery = 'missing';
    render(
      <ListView
        currentPath="/root"
        files={
          [
            {
              id: 'file-1',
              path: '/root/visible.txt',
              size: 10,
              modified: 0,
              is_dir: false,
              custom: {},
            },
          ] as any
        }
      />
    );
    expect(screen.getByText('No matching files')).toBeInTheDocument();
  });

  it('filters hidden files and injects draft entries', () => {
    storeState = {
      ...storeState,
      draftNew: { id: 'draft-1', parentPath: '/root', name: 'New Folder' },
    };

    const files = [
      {
        id: 'hidden-1',
        path: '/root/.hidden',
        size: 10,
        modified: 0,
        is_dir: false,
        custom: {},
      },
      {
        id: 'file-1',
        path: '/root/visible.txt',
        size: 10,
        modified: 0,
        is_dir: false,
        custom: {},
      },
    ];

    render(<ListView currentPath="/root" files={files as any} />);

    expect(latestTableProps).not.toBeNull();
    expect(latestTableProps.files).toHaveLength(2);
    expect(latestTableProps.files.some((f: any) => f.path.includes('.hidden'))).toBe(false);
    expect(latestTableProps.files.some((f: any) => f.is_draft)).toBe(true);
    expect(latestTableProps.droppableId).toBe('list:/root');
  });
});
