import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './GoToFolderDialog.module.css';
import { basename, normalizePathForCompare } from '../utils/path';
import { createFocusTrap } from '../utils/accessibility';
import { Icon } from './Icon';

interface GoToFolderDialogProps {
  open: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

interface Suggestion {
  path: string;
  name: string;
  isDir: boolean;
  type: 'autocomplete' | 'recent';
}

// Load recent paths from localStorage
function loadRecentPaths(): string[] {
  try {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('explorie:goToFolderRecent');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr.filter((p: unknown): p is string => typeof p === 'string').slice(0, 10);
        }
      }
    }
  } catch {}
  return [];
}

// Save recent paths to localStorage
function saveRecentPaths(paths: string[]): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('explorie:goToFolderRecent', JSON.stringify(paths.slice(0, 10)));
    }
  } catch {}
}

// Add path to recent paths
function addToRecentPaths(path: string): void {
  const recent = loadRecentPaths();
  const normalized = normalizePathForCompare(path);
  const filtered = recent.filter((p) => normalizePathForCompare(p) !== normalized);
  const updated = [path, ...filtered].slice(0, 10);
  saveRecentPaths(updated);
}

async function expandHome(path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) return path;
  const home = await invoke<string>('get_home_dir');
  return `${home}${path.slice(1)}`;
}

/**
 * GoToFolderDialog - Modal for navigating to a specific folder path
 * Features: autocomplete, home expansion, recent paths
 * Triggered by Ctrl+G
 */
export function GoToFolderDialog({
  open,
  currentPath,
  onNavigate,
  onClose,
}: GoToFolderDialogProps) {
  const [inputValue, setInputValue] = useState(currentPath);
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const trap = createFocusTrap(dialogRef.current);
    focusTrapRef.current = trap;
    trap.activate();
    return () => {
      focusTrapRef.current = null;
      trap.deactivate();
    };
  }, [open]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && inputRef.current) {
      setInputValue(currentPath);
      setError(null);
      setSuggestions([]);
      setSelectedSuggestionIndex(-1);
      setShowSuggestions(false);
      // Select all text for easy replacement
      setTimeout(() => {
        inputRef.current?.select();
      }, 10);
    }
  }, [open, currentPath]);

  // Handle escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showSuggestions) {
          setShowSuggestions(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, showSuggestions]);

  // Fetch autocomplete suggestions
  const fetchSuggestions = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        // Show recent paths when input is empty or just starting
        const recent = loadRecentPaths();
        const recentSuggestions: Suggestion[] = recent.map((p) => ({
          path: p,
          name: basename(p),
          isDir: true,
          type: 'recent' as const,
        }));
        setSuggestions(recentSuggestions);
        setShowSuggestions(recentSuggestions.length > 0);
        return;
      }

      try {
        const expandedPath = await expandHome(value);

        // Get parent directory for autocomplete
        const lastSep = Math.max(expandedPath.lastIndexOf('/'), expandedPath.lastIndexOf('\\'));
        let parentDir = '';
        let prefix = '';

        if (lastSep >= 0) {
          parentDir = expandedPath.slice(0, lastSep + 1);
          prefix = expandedPath.slice(lastSep + 1).toLowerCase();
        } else {
          // No separator - might be a drive letter or root
          if (/^[A-Za-z]:?$/.test(expandedPath)) {
            parentDir = expandedPath.length === 1 ? `${expandedPath}:/` : `${expandedPath}/`;
            prefix = '';
          } else {
            parentDir = currentPath;
            prefix = expandedPath.toLowerCase();
          }
        }

        // Fetch directory contents for autocomplete
        const entries = await invoke<Array<{ path: string; name?: string; is_dir: boolean }>>(
          'list_files',
          {
            path: parentDir,
            calc_dir_size: false,
          }
        );

        const filtered = entries
          .filter((e) => e.is_dir) // Only show directories
          .filter((e) => {
            const name = e.name || basename(e.path) || '';
            return name.toLowerCase().startsWith(prefix);
          })
          .slice(0, 10)
          .map((e) => ({
            path: e.path,
            name: e.name || basename(e.path) || '',
            isDir: e.is_dir,
            type: 'autocomplete' as const,
          }));

        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
      } catch {
        // Silent fail for autocomplete
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    [currentPath]
  );

  // Debounced autocomplete
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      fetchSuggestions(inputValue);
    }, 150);
    return () => clearTimeout(timer);
  }, [inputValue, open, fetchSuggestions]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();

      if (!inputValue.trim()) {
        setError('Please enter a path');
        return;
      }

      setIsValidating(true);
      setError(null);
      setShowSuggestions(false);

      try {
        const expandedPath = await expandHome(inputValue.trim());

        // Try to list files at the path to validate it exists
        await invoke('list_files', { path: expandedPath, calc_dir_size: false });

        // Path is valid, add to recent paths and navigate
        addToRecentPaths(expandedPath);
        onNavigate(expandedPath);
        onClose();
      } catch (err: unknown) {
        const errStr = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        if (errStr.includes('not a directory') || errStr.includes('Not a directory')) {
          setError('Path is not a directory');
        } else if (
          errStr.includes('No such file') ||
          errStr.includes('cannot find') ||
          errStr.includes('The system cannot find')
        ) {
          setError('Path does not exist');
        } else if (errStr.includes('Access') || errStr.includes('Permission')) {
          setError('Access denied');
        } else {
          setError('Invalid path');
        }
      } finally {
        setIsValidating(false);
      }
    },
    [inputValue, onNavigate, onClose]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setError(null);
    setSelectedSuggestionIndex(-1);
  }, []);

  const handleSelectSuggestion = useCallback((suggestion: Suggestion) => {
    setInputValue(suggestion.path);
    setShowSuggestions(false);
    setSelectedSuggestionIndex(-1);
    inputRef.current?.focus();
  }, []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (showSuggestions && suggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedSuggestionIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && selectedSuggestionIndex >= 0)) {
          e.preventDefault();
          const idx = selectedSuggestionIndex >= 0 ? selectedSuggestionIndex : 0;
          if (suggestions[idx]) {
            handleSelectSuggestion(suggestions[idx]);
          }
          return;
        }
      }

      if (e.key === 'Enter' && selectedSuggestionIndex < 0) {
        handleSubmit();
      }
    },
    [showSuggestions, suggestions, selectedSuggestionIndex, handleSelectSuggestion, handleSubmit]
  );

  // Scroll selected suggestion into view
  useEffect(() => {
    if (selectedSuggestionIndex >= 0 && suggestionsRef.current) {
      const item = suggestionsRef.current.children[selectedSuggestionIndex] as HTMLElement;
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedSuggestionIndex]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="go-to-folder-title"
        onKeyDown={(e) => focusTrapRef.current?.handleKeyDown(e)}
      >
        <h2 id="go-to-folder-title" className={styles.title}>
          Go to Folder
        </h2>
        <form onSubmit={handleSubmit}>
          <div className={styles.inputContainer}>
            <label className={styles.inputLabel} htmlFor="go-to-folder-input">
              Folder path
            </label>
            <input
              id="go-to-folder-input"
              ref={inputRef}
              data-autofocus
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls="go-to-folder-suggestions"
              aria-activedescendant={
                selectedSuggestionIndex >= 0
                  ? `go-to-folder-suggestion-${selectedSuggestionIndex}`
                  : undefined
              }
              className={`${styles.input} ${error ? styles.inputError : ''}`}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              onFocus={() => fetchSuggestions(inputValue)}
              placeholder="Enter folder path..."
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {error && <span className={styles.errorText}>{error}</span>}

            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                id="go-to-folder-suggestions"
                className={styles.suggestions}
                ref={suggestionsRef}
                role="listbox"
                aria-label="Folder suggestions"
              >
                {suggestions.map((suggestion, index) => (
                  <div
                    id={`go-to-folder-suggestion-${index}`}
                    key={`${suggestion.type}-${suggestion.path}`}
                    role="option"
                    aria-selected={index === selectedSuggestionIndex}
                    className={`${styles.suggestionItem} ${index === selectedSuggestionIndex ? styles.suggestionSelected : ''}`}
                    onClick={() => handleSelectSuggestion(suggestion)}
                    onMouseEnter={() => setSelectedSuggestionIndex(index)}
                  >
                    <span className={styles.suggestionIcon}>
                      <Icon name={suggestion.type === 'recent' ? 'clock' : 'folder'} size={12} />
                    </span>
                    <span className={styles.suggestionText}>{suggestion.path}</span>
                    {suggestion.type === 'recent' && (
                      <span className={styles.suggestionBadge}>Recent</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={styles.hint}>
            <span>
              Press <kbd>Enter</kbd> to navigate, <kbd>Tab</kbd> to autocomplete, <kbd>Esc</kbd> to
              cancel
            </span>
            <br />
            <span className={styles.hintSecondary}>Supports: ~ for your home folder</span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={styles.goButton}
              disabled={isValidating || !inputValue.trim()}
            >
              {isValidating ? 'Validating...' : 'Go'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default GoToFolderDialog;
