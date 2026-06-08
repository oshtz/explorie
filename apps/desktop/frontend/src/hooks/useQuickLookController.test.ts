import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { getQuickLookVisibleFiles, useQuickLookController } from './useQuickLookController';
import type { QuickLookControllerInput } from './useQuickLookController';

const alphaFile: FileEntry = {
  id: 'alpha',
  path: '/root/alpha.txt',
  name: 'alpha.txt',
  size: 100,
  modified: 1,
  hidden: false,
  is_dir: false,
  custom: {},
};

const folderEntry: FileEntry = {
  id: 'folder',
  path: '/root/Folder',
  name: 'Folder',
  size: 0,
  modified: 2,
  hidden: false,
  is_dir: true,
  custom: {},
};

const hiddenFile: FileEntry = {
  id: 'hidden',
  path: '/root/.hidden.txt',
  name: '.hidden.txt',
  size: 150,
  modified: 3,
  hidden: true,
  is_dir: false,
  custom: {},
};

const betaFile: FileEntry = {
  id: 'beta',
  path: '/root/beta.txt',
  name: 'beta.txt',
  size: 200,
  modified: 4,
  hidden: false,
  is_dir: false,
  custom: {},
};

const files: FileEntry[] = [alphaFile, folderEntry, hiddenFile, betaFile];

function renderQuickLook(overrides: Partial<QuickLookControllerInput> = {}) {
  const setSelectedFile = vi.fn();
  const hook = renderHook(
    ({ input }) =>
      useQuickLookController({
        files,
        columnFiles: {},
        pathStack: ['/root'],
        currentPath: '/root',
        viewMode: 'list',
        filterMode: 'all',
        searchQuery: '',
        showHidden: false,
        sortKey: 'name',
        sortDir: 'asc',
        selectedFile: null,
        setSelectedFile,
        ...input,
      }),
    { initialProps: { input: overrides } }
  );
  return { ...hook, setSelectedFile };
}

describe('useQuickLookController', () => {
  it('sorts visible files with sortFiles', () => {
    const ascending = getQuickLookVisibleFiles([betaFile, alphaFile], {
      filterMode: 'all',
      searchQuery: '',
      showHidden: false,
      sortKey: 'name',
      sortDir: 'asc',
    });
    const descending = getQuickLookVisibleFiles([alphaFile, betaFile], {
      filterMode: 'all',
      searchQuery: '',
      showHidden: false,
      sortKey: 'name',
      sortDir: 'desc',
    });

    expect(ascending.map((file) => file.id)).toEqual(['alpha', 'beta']);
    expect(descending.map((file) => file.id)).toEqual(['beta', 'alpha']);
  });

  it('opens selected files and skips folders and hidden files in the sequence', () => {
    const { result, rerender } = renderQuickLook({ selectedFile: folderEntry });

    let opened = true;
    act(() => {
      opened = result.current.openSelected();
    });

    expect(opened).toBe(false);
    expect(result.current.isQuickLookOpen).toBe(false);

    rerender({ input: { selectedFile: alphaFile } });

    act(() => {
      opened = result.current.openSelected();
    });

    expect(opened).toBe(true);
    expect(result.current.quickLookFile?.id).toBe('alpha');
    expect(result.current.quickLookFiles.map((file) => file.id)).toEqual(['alpha', 'beta']);
  });

  it('navigateTo syncs selected file', () => {
    const { result, setSelectedFile } = renderQuickLook({ selectedFile: alphaFile });

    act(() => {
      result.current.openSelected();
    });
    act(() => {
      result.current.navigateTo(betaFile);
    });

    expect(result.current.quickLookFile?.id).toBe('beta');
    expect(setSelectedFile).toHaveBeenCalledWith(betaFile);
  });

  it('column view uses the owning column sequence', () => {
    const rootFile: FileEntry = {
      id: 'root-file',
      path: '/root/root.txt',
      name: 'root.txt',
      size: 50,
      modified: 5,
      hidden: false,
      is_dir: false,
      custom: {},
    };

    const { result } = renderQuickLook({
      viewMode: 'column',
      selectedFile: betaFile,
      files: [],
      currentPath: '/root',
      pathStack: ['/root'],
      columnFiles: {
        '/root': [rootFile],
        '/root/Folder': files,
      },
    });

    act(() => {
      result.current.openSelected();
    });

    expect(result.current.quickLookFiles.map((file) => file.id)).toEqual(['alpha', 'beta']);
  });

  it('keeps the open file in sequence when filters change around it', () => {
    const { result, rerender } = renderQuickLook({
      selectedFile: betaFile,
    });

    act(() => {
      result.current.openSelected();
    });

    rerender({
      input: {
        selectedFile: betaFile,
        searchQuery: 'alpha',
      },
    });

    expect(result.current.quickLookFiles.map((file) => file.id)).toEqual(['beta']);
  });
});
