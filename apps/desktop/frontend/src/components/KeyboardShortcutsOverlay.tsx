import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './KeyboardShortcutsOverlay.module.css';
import { createFocusTrap } from '../utils/accessibility';
import { useFileStore } from '../store';
import {
  DEFAULT_SHORTCUTS,
  formatShortcutSpaced,
  SHORTCUT_DEFINITIONS,
  type ShortcutMap,
} from '../utils/shortcuts';

interface Shortcut {
  keys: string;
  description: string;
}

interface ShortcutCategory {
  name: string;
  shortcuts: Shortcut[];
}

const STATIC_SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    name: 'Navigation',
    shortcuts: [
      { keys: 'Enter', description: 'Open selected item' },
      { keys: 'Arrow Keys', description: 'Navigate between files' },
      { keys: 'Home', description: 'Select first item' },
      { keys: 'End', description: 'Select last item' },
    ],
  },
  {
    name: 'File Operations',
    shortcuts: [],
  },
  {
    name: 'Selection',
    shortcuts: [
      { keys: 'Ctrl + Click', description: 'Toggle item selection' },
      { keys: 'Shift + Click', description: 'Select range of items' },
      { keys: 'Escape', description: 'Clear selection' },
      { keys: 'Type letters', description: 'Select by filename' },
    ],
  },
  {
    name: 'Tabs',
    shortcuts: [{ keys: 'Alt + Up/Down', description: 'Reorder focused Favorite' }],
  },
];

const CATEGORY_NAMES: Record<string, string> = {
  navigation: 'Navigation',
  file: 'File Operations',
  selection: 'Selection',
  view: 'View',
  tabs: 'Tabs',
  commands: 'Search & Commands',
};

function buildShortcutCategories(shortcuts: ShortcutMap): ShortcutCategory[] {
  const dynamic = new Map<string, Shortcut[]>();
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.developmentOnly && !import.meta.env.DEV) continue;
    const name = CATEGORY_NAMES[definition.category];
    const entries = dynamic.get(name) ?? [];
    entries.push({
      keys: formatShortcutSpaced(shortcuts[definition.id]),
      description: definition.label,
    });
    dynamic.set(name, entries);
  }

  const categories: ShortcutCategory[] = [];
  for (const name of [
    'Navigation',
    'File Operations',
    'Selection',
    'View',
    'Tabs',
    'Search & Commands',
  ]) {
    const staticEntries = STATIC_SHORTCUT_CATEGORIES.find((category) => category.name === name);
    const dynamicEntries = dynamic.get(name) ?? [];
    const entries = [...dynamicEntries, ...(staticEntries?.shortcuts ?? [])];
    if (entries.length > 0) categories.push({ name, shortcuts: entries });
  }
  return categories;
}

interface KeyboardShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
  shortcuts?: ShortcutMap;
}

export function KeyboardShortcutsOverlay({
  open,
  onClose,
  shortcuts,
}: KeyboardShortcutsOverlayProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const storedShortcuts = useFileStore((state) => state.shortcuts);
  const currentShortcuts = shortcuts ?? storedShortcuts ?? DEFAULT_SHORTCUTS;

  useEffect(() => {
    if (!open || !overlayRef.current) return;
    const trap = createFocusTrap(overlayRef.current);
    focusTrapRef.current = trap;
    trap.activate();
    return () => {
      focusTrapRef.current = null;
      trap.deactivate();
    };
  }, [open]);

  // Filter shortcuts based on search query
  const filteredCategories = useMemo(() => {
    const categories = buildShortcutCategories(currentShortcuts);
    if (!searchQuery.trim()) return categories;

    const query = searchQuery.toLowerCase();
    return categories
      .map((category) => ({
        ...category,
        shortcuts: category.shortcuts.filter(
          (shortcut) =>
            shortcut.keys.toLowerCase().includes(query) ||
            shortcut.description.toLowerCase().includes(query)
        ),
      }))
      .filter((category) => category.shortcuts.length > 0);
  }, [currentShortcuts, searchQuery]);

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
        onKeyDown={(e) => {
          focusTrapRef.current?.handleKeyDown(e);
          handleKeyDown(e);
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
      >
        <div className={styles.header}>
          <h2 id="keyboard-shortcuts-title" className={styles.title}>
            Keyboard shortcuts
          </h2>
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
            data-autofocus
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
                      <div
                        key={`${shortcut.description}-${shortcut.keys}`}
                        className={styles.shortcutItem}
                      >
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
            Press <kbd>Esc</kbd> to close
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
