import { useCallback, useMemo, useState } from 'react';
import type { FileEntry } from '../store';
import { sortFiles } from '../components/FileTable';
import type { SortDir, SortKey } from '../components/FileTable';
import type { ViewMode } from '../components/ViewModeToggle';

interface QuickLookSequenceOptions {
  filterMode: 'all' | 'folders' | 'files';
  searchQuery: string;
  showHidden: boolean;
  sortDir: SortDir;
  sortKey: SortKey;
}

export interface QuickLookControllerInput extends QuickLookSequenceOptions {
  files: FileEntry[];
  columnFiles: Record<string, FileEntry[]>;
  pathStack: string[];
  currentPath: string;
  viewMode: ViewMode;
  selectedFile: FileEntry | null;
  setSelectedFile: (file: FileEntry | null) => void;
}

function getFileName(file: FileEntry): string {
  return file.name ?? file.path.split(/[\\/]/).pop() ?? file.path;
}

function isHiddenEntry(file: FileEntry): boolean {
  if (file.hidden === true) return true;
  return getFileName(file).startsWith('.');
}

export function getQuickLookVisibleFiles(
  entries: FileEntry[],
  { filterMode, searchQuery, showHidden, sortDir, sortKey }: QuickLookSequenceOptions
): FileEntry[] {
  if (filterMode === 'folders') return [];

  const safeEntries = Array.isArray(entries) ? entries : [];
  const hiddenFiltered = showHidden
    ? safeEntries
    : safeEntries.filter((entry) => !isHiddenEntry(entry));
  const fileOnly = hiddenFiltered.filter((entry) => !entry.is_dir);
  const query = searchQuery.trim().toLowerCase();
  const searched = query
    ? fileOnly.filter((entry) => getFileName(entry).toLowerCase().includes(query))
    : fileOnly;

  return sortFiles(searched, sortKey, sortDir);
}

function ensureQuickLookFileInSequence(sequence: FileEntry[], file: FileEntry | null): FileEntry[] {
  if (!file || sequence.some((entry) => entry.id === file.id)) return sequence;
  return [file];
}

export function useQuickLookController(input: QuickLookControllerInput) {
  const {
    files,
    columnFiles,
    pathStack,
    currentPath,
    viewMode,
    selectedFile,
    setSelectedFile,
    filterMode,
    searchQuery,
    showHidden,
    sortDir,
    sortKey,
  } = input;
  const [quickLookFile, setQuickLookFile] = useState<FileEntry | null>(null);

  const quickLookFiles = useMemo(() => {
    const options: QuickLookSequenceOptions = {
      filterMode,
      searchQuery,
      showHidden,
      sortDir,
      sortKey,
    };

    if (viewMode === 'column') {
      const candidatePaths = [
        ...pathStack,
        ...Object.keys(columnFiles).filter((path) => !pathStack.includes(path)),
      ];
      const getColumnSequence = (path: string): FileEntry[] =>
        getQuickLookVisibleFiles(columnFiles[path] ?? [], options);
      const matchingPath =
        quickLookFile && candidatePaths.length > 0
          ? candidatePaths.find((path) =>
              getColumnSequence(path).some((entry) => entry.id === quickLookFile.id)
            )
          : currentPath;
      const columnSequence = matchingPath ? getColumnSequence(matchingPath) : [];

      return ensureQuickLookFileInSequence(columnSequence, quickLookFile);
    }

    return ensureQuickLookFileInSequence(getQuickLookVisibleFiles(files, options), quickLookFile);
  }, [
    columnFiles,
    currentPath,
    files,
    filterMode,
    pathStack,
    quickLookFile,
    searchQuery,
    showHidden,
    sortDir,
    sortKey,
    viewMode,
  ]);

  const openFile = useCallback((file: FileEntry | null): boolean => {
    if (!file || file.is_dir) return false;
    setQuickLookFile(file);
    return true;
  }, []);

  const openSelected = useCallback((): boolean => openFile(selectedFile), [openFile, selectedFile]);

  const close = useCallback(() => {
    setQuickLookFile(null);
  }, []);

  const navigateTo = useCallback(
    (file: FileEntry) => {
      setQuickLookFile(file);
      setSelectedFile(file);
    },
    [setSelectedFile]
  );

  return {
    quickLookFile,
    quickLookFiles,
    isQuickLookOpen: quickLookFile !== null,
    openFile,
    openSelected,
    close,
    navigateTo,
  };
}
