import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import styles from './CommandPalette.module.css';
import { createFocusTrap } from '../utils/accessibility';

export interface Command {
  id: string;
  name: string;
  shortcut?: string;
  category: 'navigation' | 'file' | 'view' | 'tab' | 'settings';
  action: () => void;
}

const RECENTS_STORAGE_KEY = 'explorie:recentCommands';
const MAX_RECENT_COMMANDS = 5;

function getRecentCommandIds(): string[] {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr
            .filter((id: unknown): id is string => typeof id === 'string')
            .slice(0, MAX_RECENT_COMMANDS);
        }
      }
    }
  } catch {}
  return [];
}

function saveRecentCommandId(commandId: string): void {
  try {
    if (typeof window !== 'undefined') {
      const current = getRecentCommandIds();
      const updated = [commandId, ...current.filter((id) => id !== commandId)].slice(
        0,
        MAX_RECENT_COMMANDS
      );
      window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(updated));
    }
  } catch {}
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

// Simple fuzzy match - returns true if all chars in query appear in target in order
function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return { match: true, score: 0 };

  let qIdx = 0;
  let score = 0;
  let consecutiveBonus = 0;

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      score += 1 + consecutiveBonus;
      consecutiveBonus += 1;
      qIdx++;
    } else {
      consecutiveBonus = 0;
    }
  }

  // Extra points if query matches start of word
  if (t.startsWith(q)) {
    score += 10;
  }

  return { match: qIdx === q.length, score };
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => getRecentCommandIds());
  const inputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !paletteRef.current) return;
    const trap = createFocusTrap(paletteRef.current);
    focusTrapRef.current = trap;
    trap.activate();
    return () => {
      focusTrapRef.current = null;
      trap.deactivate();
    };
  }, [open]);

  // Get recent commands that exist in the commands list
  const recentCommands = useMemo(() => {
    return recentIds
      .map((id) => commands.find((cmd) => cmd.id === id))
      .filter((cmd): cmd is Command => cmd !== undefined);
  }, [recentIds, commands]);

  // Filter and sort commands based on query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      // Show all commands, grouped by category
      return commands;
    }

    const results = commands
      .map((cmd) => {
        const nameMatch = fuzzyMatch(query, cmd.name);
        const categoryMatch = fuzzyMatch(query, cmd.category);
        const bestScore = Math.max(nameMatch.score, categoryMatch.score * 0.5);
        return { cmd, match: nameMatch.match || categoryMatch.match, score: bestScore };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.cmd);

    return results;
  }, [commands, query]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when palette opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Refresh recent commands from storage
      setRecentIds(getRecentCommandIds());
      // Small delay to ensure modal is visible
      setTimeout(() => {
        inputRef.current?.focus();
      }, 10);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selected?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const executeCommand = useCallback(
    (cmd: Command) => {
      // Save to recent commands
      saveRecentCommandId(cmd.id);
      setRecentIds(getRecentCommandIds());

      onClose();
      // Execute after modal closes
      setTimeout(() => {
        cmd.action();
      }, 50);
    },
    [onClose]
  );

  // Compute total item count including recent commands
  const totalItemCount = useMemo(() => {
    const showRecents = !query.trim() && recentCommands.length > 0;
    return showRecents ? filteredCommands.length + recentCommands.length : filteredCommands.length;
  }, [query, recentCommands, filteredCommands]);

  // Get command at a given flat index
  const getCommandAtIndex = useCallback(
    (idx: number): Command | undefined => {
      const showRecents = !query.trim() && recentCommands.length > 0;
      if (showRecents) {
        if (idx < recentCommands.length) {
          return recentCommands[idx];
        }
        return filteredCommands[idx - recentCommands.length];
      }
      return filteredCommands[idx];
    },
    [query, recentCommands, filteredCommands]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, totalItemCount - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          const cmd = getCommandAtIndex(selectedIndex);
          if (cmd) {
            executeCommand(cmd);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [totalItemCount, selectedIndex, executeCommand, onClose, getCommandAtIndex]
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

  // Group commands by category for display
  const groupedCommands = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    for (const cmd of filteredCommands) {
      if (!groups[cmd.category]) {
        groups[cmd.category] = [];
      }
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredCommands]);

  if (!open) return null;

  const categoryLabels: Record<string, string> = {
    recent: 'Recently Used',
    navigation: 'Navigation',
    file: 'File Operations',
    view: 'View',
    tab: 'Tabs',
    settings: 'Settings',
  };

  // Flatten grouped commands for index-based selection
  let flatIndex = 0;
  const renderItems: React.ReactNode[] = [];

  // Show "Recently Used" section only when there's no query and we have recent commands
  const showRecents = !query.trim() && recentCommands.length > 0;
  const categoryOrder = showRecents
    ? ['recent', 'navigation', 'file', 'view', 'tab', 'settings']
    : ['navigation', 'file', 'view', 'tab', 'settings'];

  // Add recent commands to grouped commands if showing recents
  const displayGroupedCommands = showRecents
    ? { recent: recentCommands, ...groupedCommands }
    : groupedCommands;

  for (const category of categoryOrder) {
    const cmds = displayGroupedCommands[category];
    if (!cmds || cmds.length === 0) continue;

    renderItems.push(
      <div key={`cat-${category}`} className={styles.categoryHeader}>
        {categoryLabels[category]}
      </div>
    );

    for (const cmd of cmds) {
      const idx = flatIndex;
      renderItems.push(
        <div
          key={`${category}-${cmd.id}`}
          data-index={idx}
          className={`${styles.commandItem} ${idx === selectedIndex ? styles.selected : ''}`}
          onClick={() => executeCommand(cmd)}
          onMouseEnter={() => setSelectedIndex(idx)}
        >
          <span className={styles.commandName}>{cmd.name}</span>
          {cmd.shortcut && <kbd className={styles.shortcut}>{cmd.shortcut}</kbd>}
        </div>
      );
      flatIndex++;
    }
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={paletteRef}
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          focusTrapRef.current?.handleKeyDown(e);
          handleKeyDown(e);
        }}
      >
        <div className={styles.inputWrapper}>
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
            className={styles.input}
            placeholder="Type a command or search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={styles.commandList} ref={listRef}>
          {filteredCommands.length === 0 ? (
            <div className={styles.noResults}>No commands found</div>
          ) : (
            renderItems
          )}
        </div>
        <div className={styles.footer}>
          <span>
            <kbd>Enter</kbd> to select
          </span>
          <span>
            <kbd>Up</kbd>/<kbd>Down</kbd> to navigate
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
