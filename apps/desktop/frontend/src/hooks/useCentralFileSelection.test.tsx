import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFileStore, type FileEntry } from '../store';
import { useCentralFileSelection } from './useCentralFileSelection';

const files: FileEntry[] = [
  { id: 'a', path: '/a', name: 'a', size: 1, modified: 0, is_dir: false, custom: {} },
  { id: 'b', path: '/b', name: 'b', size: 1, modified: 0, is_dir: false, custom: {} },
];

describe('useCentralFileSelection', () => {
  beforeEach(() => useFileStore.getState().clearSelection());

  it('stores selection and cursor by path', () => {
    const { result } = renderHook(() => useCentralFileSelection(files));

    act(() => {
      result.current.setSelectedIds(new Set(['b']));
      result.current.setCursorIndex(1);
    });

    expect(useFileStore.getState().selectedPaths).toEqual(['/b']);
    expect(useFileStore.getState().selectionCursorPath).toBe('/b');
    expect(result.current.selectedIds).toEqual(new Set(['b']));
    expect(result.current.cursorIndex).toBe(1);
  });

  it('preserves selection when another view uses different entry ids for the same paths', () => {
    const { result, rerender } = renderHook(({ entries }) => useCentralFileSelection(entries), {
      initialProps: { entries: files },
    });
    act(() => {
      result.current.setSelectedIds(new Set(['a']));
      result.current.setCursorIndex(0);
    });

    rerender({
      entries: [
        { ...files[0], id: 'grid-a' },
        { ...files[1], id: 'grid-b' },
      ],
    });

    expect(result.current.selectedIds).toEqual(new Set(['grid-a']));
    expect(result.current.cursorIndex).toBe(0);
  });
});
