import { useEffect, useRef, useCallback } from 'react';
import { getFocusableElements } from '../utils/accessibility';

interface UseFocusTrapOptions {
  /** Whether the focus trap is active */
  enabled?: boolean;
  /** Element to focus when trap activates (defaults to first focusable) */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /** Whether to restore focus when trap deactivates */
  restoreFocus?: boolean;
}

/**
 * Hook to trap focus within a container element.
 * Useful for modals, dialogs, and other overlay components.
 */
export function useFocusTrap<T extends HTMLElement>(options: UseFocusTrapOptions = {}) {
  const { enabled = true, initialFocusRef, restoreFocus = true } = options;

  const containerRef = useRef<T>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Handle Tab key to trap focus
  const handleKeyDown = useCallback((e: React.KeyboardEvent | KeyboardEvent) => {
    if (e.key !== 'Tab' || !containerRef.current) return;

    const focusable = getFocusableElements(containerRef.current);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && active === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && active === last) {
      first.focus();
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    // Store currently focused element
    previouslyFocusedRef.current = document.activeElement as HTMLElement;

    // Focus initial element or first focusable
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      const focusable = getFocusableElements(containerRef.current);
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    }

    return () => {
      // Restore focus when trap deactivates
      if (restoreFocus && previouslyFocusedRef.current?.focus) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [enabled, initialFocusRef, restoreFocus]);

  return {
    containerRef,
    handleKeyDown,
  };
}

export default useFocusTrap;
