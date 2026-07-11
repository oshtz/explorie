import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';

type SetIds = Dispatch<SetStateAction<Set<string>>>;
type SetIndex = Dispatch<SetStateAction<number | null>>;

export function useCentralFileSelection(files: FileEntry[]): {
  selectedIds: Set<string>;
  setSelectedIds: SetIds;
  cursorIndex: number | null;
  setCursorIndex: SetIndex;
} {
  const selectedPaths = useFileStore((state) => state.selectedPaths);
  const cursorPath = useFileStore((state) => state.selectionCursorPath);
  const setSelectedPaths = useFileStore((state) => state.setSelectedPaths);
  const setCursorPath = useFileStore((state) => state.setSelectionCursorPath);

  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedIds = useMemo(
    () => new Set(files.filter((file) => selectedPathSet.has(file.path)).map((file) => file.id)),
    [files, selectedPathSet]
  );
  const cursorIndex = useMemo(() => {
    if (!cursorPath) return null;
    const index = files.findIndex((file) => file.path === cursorPath);
    return index >= 0 ? index : null;
  }, [cursorPath, files]);

  const setSelectedIds = useCallback<SetIds>(
    (nextValue) => {
      const currentPaths = new Set(useFileStore.getState().selectedPaths);
      const currentIds = new Set(
        files.filter((file) => currentPaths.has(file.path)).map((file) => file.id)
      );
      const next = typeof nextValue === 'function' ? nextValue(currentIds) : nextValue;
      setSelectedPaths(files.filter((file) => next.has(file.id)).map((file) => file.path));
    },
    [files, setSelectedPaths]
  );

  const setCursorIndex = useCallback<SetIndex>(
    (nextValue) => {
      const currentPath = useFileStore.getState().selectionCursorPath;
      const current = currentPath ? files.findIndex((file) => file.path === currentPath) : null;
      const next = typeof nextValue === 'function' ? nextValue(current) : nextValue;
      setCursorPath(next === null ? null : (files[next]?.path ?? null));
    },
    [files, setCursorPath]
  );

  return { selectedIds, setSelectedIds, cursorIndex, setCursorIndex };
}
