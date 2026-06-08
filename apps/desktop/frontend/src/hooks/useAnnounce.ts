import { useCallback } from 'react';
import {
  announce,
  announceSelection,
  announceOperation,
  announceNavigation,
} from '../utils/accessibility';

/**
 * Hook to provide screen reader announcement functions.
 * Wraps the accessibility utility functions for use in React components.
 */
export function useAnnounce() {
  const announceMessage = useCallback(
    (message: string, priority: 'polite' | 'assertive' = 'polite') => {
      announce(message, priority);
    },
    []
  );

  const announceSelectionChange = useCallback((count: number, total: number) => {
    announceSelection(count, total);
  }, []);

  const announceOperationResult = useCallback(
    (operation: string, success: boolean, details?: string) => {
      announceOperation(operation, success, details);
    },
    []
  );

  const announceNavigationChange = useCallback((path: string) => {
    announceNavigation(path);
  }, []);

  return {
    announce: announceMessage,
    announceSelection: announceSelectionChange,
    announceOperation: announceOperationResult,
    announceNavigation: announceNavigationChange,
  };
}

export default useAnnounce;
