/**
 * Accessibility utilities for explorie
 * Provides centralized ARIA patterns, live region announcements, and keyboard navigation helpers
 */

// ============================================================================
// LIVE REGION ANNOUNCEMENTS
// ============================================================================

let liveRegion: HTMLElement | null = null;

/**
 * Get or create a live region for screen reader announcements
 */
function getLiveRegion(): HTMLElement {
  if (liveRegion && document.body.contains(liveRegion)) {
    return liveRegion;
  }

  liveRegion = document.createElement('div');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  liveRegion.className = 'sr-only';
  // Visually hidden but accessible to screen readers
  Object.assign(liveRegion.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: '0',
  });
  document.body.appendChild(liveRegion);
  return liveRegion;
}

/**
 * Announce a message to screen readers via a live region
 * @param message - The message to announce
 * @param priority - 'polite' waits for user to finish, 'assertive' interrupts
 */
export function announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const region = getLiveRegion();
  region.setAttribute('aria-live', priority);
  // Clear and re-set to trigger announcement
  region.textContent = '';
  // Small delay to ensure screen readers detect the change
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

/**
 * Announce file selection changes
 */
export function announceSelection(count: number, total: number): void {
  if (count === 0) {
    announce('Selection cleared');
  } else if (count === total) {
    announce(`All ${count} items selected`);
  } else {
    announce(`${count} of ${total} items selected`);
  }
}

/**
 * Announce file operation results
 */
export function announceOperation(operation: string, success: boolean, details?: string): void {
  const status = success ? 'completed' : 'failed';
  const message = details ? `${operation} ${status}: ${details}` : `${operation} ${status}`;
  announce(message, success ? 'polite' : 'assertive');
}

/**
 * Announce navigation changes
 */
export function announceNavigation(path: string): void {
  const folderName = path.split(/[/\\]/).pop() || path;
  announce(`Navigated to ${folderName}`);
}

// ============================================================================
// KEYBOARD NAVIGATION HELPERS
// ============================================================================

/**
 * Handle arrow key navigation in a grid or list
 */
export interface GridNavigationOptions {
  /** Total number of items */
  itemCount: number;
  /** Number of columns (1 for list view) */
  columns?: number;
  /** Current focused index */
  currentIndex: number;
  /** Whether to wrap around at edges */
  wrap?: boolean;
}

/**
 * Calculate the next index based on arrow key navigation
 */
export function getNextIndex(
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
  options: GridNavigationOptions
): number {
  const { itemCount, columns = 1, currentIndex, wrap = false } = options;

  if (itemCount === 0) return -1;

  switch (key) {
    case 'ArrowDown': {
      const next = currentIndex + columns;
      if (next >= itemCount) {
        return wrap ? currentIndex % columns : currentIndex;
      }
      return next;
    }
    case 'ArrowUp': {
      const next = currentIndex - columns;
      if (next < 0) {
        if (wrap) {
          const lastRowStart = Math.floor((itemCount - 1) / columns) * columns;
          const targetCol = currentIndex % columns;
          return Math.min(lastRowStart + targetCol, itemCount - 1);
        }
        return currentIndex;
      }
      return next;
    }
    case 'ArrowRight': {
      if (columns === 1) return currentIndex; // No horizontal nav in single column
      const next = currentIndex + 1;
      if (next >= itemCount || (next % columns === 0 && !wrap)) {
        return wrap ? Math.floor(currentIndex / columns) * columns : currentIndex;
      }
      return next;
    }
    case 'ArrowLeft': {
      if (columns === 1) return currentIndex; // No horizontal nav in single column
      const next = currentIndex - 1;
      if (next < 0 || (currentIndex % columns === 0 && !wrap)) {
        return wrap
          ? Math.min(Math.floor(currentIndex / columns) * columns + columns - 1, itemCount - 1)
          : currentIndex;
      }
      return next;
    }
    case 'Home':
      return 0;
    case 'End':
      return itemCount - 1;
    default:
      return currentIndex;
  }
}

// ============================================================================
// FOCUS MANAGEMENT
// ============================================================================

/**
 * Get all focusable elements within a container
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

/**
 * Trap focus within a container (for modals, dialogs)
 */
export function createFocusTrap(container: HTMLElement): {
  activate: () => void;
  deactivate: () => void;
  handleKeyDown: (e: KeyboardEvent | React.KeyboardEvent) => void;
} {
  let previouslyFocused: HTMLElement | null = null;

  const handleKeyDown = (e: KeyboardEvent | React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
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
  };

  return {
    activate: () => {
      previouslyFocused = document.activeElement as HTMLElement;
      const focusable = getFocusableElements(container);
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    },
    deactivate: () => {
      if (previouslyFocused && previouslyFocused.focus) {
        previouslyFocused.focus();
      }
    },
    handleKeyDown,
  };
}

// ============================================================================
// ARIA HELPERS
// ============================================================================

/**
 * Generate ARIA attributes for a sortable column header
 */
export function getSortableColumnProps(
  columnKey: string,
  currentSortKey: string | null,
  currentSortDir: 'asc' | 'desc'
): {
  'aria-sort': 'ascending' | 'descending' | 'none';
  'aria-label': string;
} {
  const isSorted = columnKey === currentSortKey;
  return {
    'aria-sort': isSorted ? (currentSortDir === 'asc' ? 'ascending' : 'descending') : 'none',
    'aria-label': isSorted
      ? `${columnKey}, sorted ${currentSortDir === 'asc' ? 'ascending' : 'descending'}, click to sort ${currentSortDir === 'asc' ? 'descending' : 'ascending'}`
      : `${columnKey}, click to sort ascending`,
  };
}

/**
 * Generate ARIA attributes for a selectable row
 */
export function getSelectableRowProps(
  isSelected: boolean,
  rowIndex: number,
  _totalRows: number
): {
  'aria-selected': boolean;
  'aria-rowindex': number;
  role: 'row';
} {
  return {
    'aria-selected': isSelected,
    'aria-rowindex': rowIndex + 1, // ARIA uses 1-based indexing
    role: 'row',
  };
}

/**
 * Generate ARIA attributes for a menu
 */
export function getMenuProps(isOpen: boolean): {
  role: 'menu';
  'aria-hidden': boolean;
} {
  return {
    role: 'menu',
    'aria-hidden': !isOpen,
  };
}

/**
 * Generate ARIA attributes for a menu item
 */
export function getMenuItemProps(label: string): {
  role: 'menuitem';
  'aria-label': string;
  tabIndex: number;
} {
  return {
    role: 'menuitem',
    'aria-label': label,
    tabIndex: -1,
  };
}

/**
 * Generate ARIA attributes for a button that opens a menu/popover
 */
export function getMenuButtonProps(
  isOpen: boolean,
  menuId: string,
  label: string
): {
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog' | 'listbox';
  'aria-controls': string;
  'aria-label': string;
} {
  return {
    'aria-expanded': isOpen,
    'aria-haspopup': 'menu',
    'aria-controls': menuId,
    'aria-label': label,
  };
}

// ============================================================================
// REDUCED MOTION
// ============================================================================

/**
 * Check if user prefers reduced motion
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Get animation duration based on user preference
 * @param normalDuration - Duration in ms when motion is allowed
 * @returns 0 if reduced motion preferred, otherwise normalDuration
 */
export function getAnimationDuration(normalDuration: number): number {
  return prefersReducedMotion() ? 0 : normalDuration;
}

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================

/**
 * Format a keyboard shortcut for display and screen readers
 */
export function formatShortcut(
  key: string,
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
): string {
  const parts: string[] = [];

  if (modifiers?.ctrl) parts.push('Ctrl');
  if (modifiers?.alt) parts.push('Alt');
  if (modifiers?.shift) parts.push('Shift');
  if (modifiers?.meta) parts.push('Cmd');

  parts.push(key);

  return parts.join('+');
}

/**
 * Create an aria-keyshortcuts value from modifier flags
 */
export function getAriaKeyShortcuts(
  key: string,
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
): string {
  const parts: string[] = [];

  if (modifiers?.ctrl) parts.push('Control');
  if (modifiers?.alt) parts.push('Alt');
  if (modifiers?.shift) parts.push('Shift');
  if (modifiers?.meta) parts.push('Meta');

  parts.push(key);

  return parts.join('+');
}
