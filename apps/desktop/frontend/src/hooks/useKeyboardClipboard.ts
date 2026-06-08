import { useEffect, useRef, useCallback } from 'react';
import type { FileEntry } from '../store';
import type { ShowToastFn } from '../utils/fileOperations';
import {
  moveWithUndoAndConflictResolution,
  copyWithUndoAndConflictResolution,
} from '../utils/fileOperations';
import { useOperationQueueStore } from '../operationQueueStore';
import { reportError } from '../utils/errorReporter';

/**
 * Type for a function that returns currently selected files
 */
export type GetSelectedFilesFunction = () => FileEntry[];

/**
 * Interface for keyboard clipboard manager options
 */
interface KeyboardClipboardManagerOptions {
  currentPath: string;
  setClipboard: (
    clip: { mode: 'copy' | 'cut'; items: FileEntry[]; sourcePath: string } | null
  ) => void;
  clipboard: { mode: 'copy' | 'cut'; items: FileEntry[]; sourcePath: string } | null;
  showToast: ShowToastFn;
  onRefresh: () => Promise<void>;
}

/**
 * Hook for managing keyboard clipboard operations at the App level.
 * Returns a ref that view components should use to register their selection getters.
 *
 * @param options - Options for clipboard operations
 * @returns Object containing the registration ref and keyboard event handler
 */
export function useKeyboardClipboardManager({
  currentPath,
  setClipboard,
  clipboard,
  showToast,
  onRefresh,
}: KeyboardClipboardManagerOptions) {
  const getSelectedFilesRef = useRef<GetSelectedFilesFunction | null>(null);

  const handleCopy = useCallback(() => {
    const getSelectedFiles = getSelectedFilesRef.current;
    if (!getSelectedFiles) return false;

    const selectedFiles = getSelectedFiles();
    if (selectedFiles.length === 0) return false;

    setClipboard({
      mode: 'copy',
      items: selectedFiles,
      sourcePath: currentPath,
    });

    showToast(
      selectedFiles.length === 1
        ? `Copied "${selectedFiles[0].name}"`
        : `Copied ${selectedFiles.length} items`,
      { type: 'success' }
    );
    return true;
  }, [currentPath, setClipboard, showToast]);

  const handleCut = useCallback(() => {
    const getSelectedFiles = getSelectedFilesRef.current;
    if (!getSelectedFiles) return false;

    const selectedFiles = getSelectedFiles();
    if (selectedFiles.length === 0) return false;

    setClipboard({
      mode: 'cut',
      items: selectedFiles,
      sourcePath: currentPath,
    });

    showToast(
      selectedFiles.length === 1
        ? `Cut "${selectedFiles[0].name}"`
        : `Cut ${selectedFiles.length} items`,
      { type: 'success' }
    );
    return true;
  }, [currentPath, setClipboard, showToast]);

  const handlePaste = useCallback(async () => {
    if (!clipboard || clipboard.items.length === 0) {
      showToast('Nothing to paste', { type: 'info' });
      return false;
    }

    // If pasting to the same location, show info message
    if (clipboard.sourcePath === currentPath) {
      showToast('Cannot paste to the same location', { type: 'info' });
      return false;
    }

    // Get conflict resolution setting from operation queue store
    const storeResolution = useOperationQueueStore.getState().defaultConflictResolution;
    // Map 'rename' to 'keepBoth' since they achieve the same goal
    const conflictResolution = storeResolution === 'rename' ? 'keepBoth' : storeResolution;

    try {
      if (clipboard.mode === 'cut') {
        await moveWithUndoAndConflictResolution(
          clipboard.items,
          currentPath,
          showToast,
          onRefresh,
          { conflictResolution: conflictResolution as 'skip' | 'replace' | 'keepBoth' | 'ask' }
        );
        setClipboard(null);
      } else if (clipboard.mode === 'copy') {
        await copyWithUndoAndConflictResolution(
          clipboard.items,
          currentPath,
          showToast,
          onRefresh,
          { conflictResolution: conflictResolution as 'skip' | 'replace' | 'keepBoth' | 'ask' }
        );
      }
    } catch (e) {
      reportError('Paste failed', e, { toast: showToast });
    }

    return true;
  }, [clipboard, currentPath, onRefresh, setClipboard, showToast]);

  // Keyboard event handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // Don't trigger shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      const isInputField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (isInputField) return;

      // Ctrl+C for copy
      if (ctrlOrMeta && (e.key === 'c' || e.key === 'C') && !e.shiftKey && !e.altKey) {
        if (handleCopy()) {
          e.preventDefault();
        }
        return;
      }

      // Ctrl+X for cut
      if (ctrlOrMeta && (e.key === 'x' || e.key === 'X') && !e.shiftKey && !e.altKey) {
        if (handleCut()) {
          e.preventDefault();
        }
        return;
      }

      // Ctrl+V for paste
      if (ctrlOrMeta && (e.key === 'v' || e.key === 'V') && !e.shiftKey && !e.altKey) {
        handlePaste();
        e.preventDefault();
        return;
      }
    },
    [handleCopy, handleCut, handlePaste]
  );

  // Attach keyboard event listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return {
    getSelectedFilesRef,
    handleCopy,
    handleCut,
    handlePaste,
  };
}
