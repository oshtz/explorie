import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './KeyboardShortcutsOverlay.module.css';

interface Shortcut {
  keys: string;
  description: string;
}

interface ShortcutCategory {
  name: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    name: 'Navigation',
    shortcuts: [
      { keys: 'Alt + Left', description: 'Go back' },
      { keys: 'Alt + Right', description: 'Go forward' },
      { keys: 'Ctrl + G', description: 'Go to folder' },
      { keys: 'Enter', description: 'Open selected item' },
      { keys: 'Backspace', description: 'Go up one directory' },
      { keys: 'Arrow Keys', description: 'Navigate between files' },
      { keys: 'Home', description: 'Select first item' },
      { keys: 'End', description: 'Select last item' },
    ],
  },
  {
    name: 'File Operations',
    shortcuts: [
      { keys: 'Delete', description: 'Delete selected item' },
      { keys: 'F2', description: 'Rename selected item' },
      { keys: 'Ctrl + C', description: 'Copy selected items' },
      { keys: 'Ctrl + X', description: 'Cut selected items' },
      { keys: 'Ctrl + V', description: 'Paste items' },
      { keys: 'Ctrl + Z', description: 'Undo last action' },
      { keys: 'Ctrl + Y', description: 'Redo last action' },
      { keys: 'Ctrl + D', description: 'Add to favorites' },
    ],
  },
  {
    name: 'Selection',
    shortcuts: [
      { keys: 'Ctrl + A', description: 'Select all items' },
      { keys: 'Ctrl + Click', description: 'Toggle item selection' },
      { keys: 'Shift + Click', description: 'Select range of items' },
      { keys: 'Escape', description: 'Clear selection' },
    ],
  },
  {
    name: 'View',
    shortcuts: [
      { keys: 'Ctrl + 1', description: 'List view' },
      { keys: 'Ctrl + 2', description: 'Grid view' },
      { keys: 'Ctrl + 3', description: 'Column view' },
      { keys: 'Ctrl + H', description: 'Toggle hidden files' },
      { keys: 'F5', description: 'Refresh' },
      { keys: 'Space', description: 'Quick Look preview' },
      { keys: '+', description: 'Increase thumbnail size (Grid)' },
      { keys: '-', description: 'Decrease thumbnail size (Grid)' },
    ],
  },
  {
    name: 'Tabs',
    shortcuts: [
      { keys: 'Ctrl + T', description: 'New tab' },
      { keys: 'Ctrl + W', description: 'Close current tab' },
      { keys: 'Ctrl + Tab', description: 'Next tab' },
      { keys: 'Ctrl + Shift + Tab', description: 'Previous tab' },
    ],
  },
  {
    name: 'Search & Commands',
    shortcuts: [
      { keys: 'Ctrl + F', description: 'Search files' },
      { keys: 'Ctrl + Shift + P', description: 'Open command palette' },
      { keys: '?', description: 'Show keyboard shortcuts' },
    ],
  },
];

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsOverlay({ open, onClose }: KeyboardShortcutsOverlayProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Filter shortcuts based on search query
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) {
      return SHORTCUT_CATEGORIES;
    }

    const query = searchQuery.toLowerCase();
    return SHORTCUT_CATEGORIES.map((category) => ({
      ...category,
      shortcuts: category.shortcuts.filter(
        (shortcut) =>
          shortcut.keys.toLowerCase().includes(query) ||
          shortcut.description.toLowerCase().includes(query)
      ),
    })).filter((category) => category.shortcuts.length > 0);
  }, [searchQuery]);

  // Focus search input when opened
  useEffect(() => {
    if (open) {
      setSearchQuery('');
      setTimeout(() => {
        inputRef.current?.focus();
      }, 10);
    }
  }, [open]);

  // Close on Escape or any other key (except when typing in search)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  // Global key listener to close overlay on any key except when typing
  useEffect(() => {
    if (!open) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Allow typing in search input
      if (e.target === inputRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
        return;
      }

      // Close on any key press (except modifiers alone)
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [open, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={overlayRef}
        className={styles.overlay}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Keyboard Shortcuts</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className={styles.searchWrapper}>
          <svg
            className={styles.searchIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className={styles.searchInput}
            placeholder="Search shortcuts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={styles.content}>
          {filteredCategories.length === 0 ? (
            <div className={styles.noResults}>No shortcuts found</div>
          ) : (
            <div className={styles.grid}>
              {filteredCategories.map((category) => (
                <div key={category.name} className={styles.category}>
                  <h3 className={styles.categoryTitle}>{category.name}</h3>
                  <div className={styles.shortcuts}>
                    {category.shortcuts.map((shortcut) => (
                      <div key={shortcut.keys} className={styles.shortcutItem}>
                        <span className={styles.description}>{shortcut.description}</span>
                        <kbd className={styles.keys}>{shortcut.keys}</kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <span>
            Press <kbd>Esc</kbd> or any key to close
          </span>
          <a
            className={styles.docsLink}
            href="https://github.com/explorie/explorie#keyboard-shortcuts"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            View full documentation
          </a>
        </div>
      </div>
    </div>
  );
}

export default KeyboardShortcutsOverlay;
