import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './GoToFolderDialog.module.css';
import { basename, normalizePathForCompare } from '../utils/path';

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
  type: 'autocomplete' | 'recent' | 'env';
}

// Common environment variables for different platforms
const COMMON_ENV_VARS = [
  { var: '%USERPROFILE%', desc: 'User home (Windows)', platform: 'win32' },
  { var: '%APPDATA%', desc: 'App data (Windows)', platform: 'win32' },
  { var: '%LOCALAPPDATA%', desc: 'Local app data (Windows)', platform: 'win32' },
  { var: '%PROGRAMFILES%', desc: 'Program Files (Windows)', platform: 'win32' },
  { var: '%TEMP%', desc: 'Temp folder (Windows)', platform: 'win32' },
  { var: '%DESKTOP%', desc: 'Desktop (Windows)', platform: 'win32' },
  { var: '%DOCUMENTS%', desc: 'Documents (Windows)', platform: 'win32' },
  { var: '$HOME', desc: 'User home (Unix)', platform: 'unix' },
  { var: '$USER', desc: 'Username (Unix)', platform: 'unix' },
  { var: '~', desc: 'User home (Unix shorthand)', platform: 'unix' },
];

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

// Expand environment variables in path
async function expandEnvironmentVariables(path: string): Promise<string> {
  let expanded = path;

  // Handle ~ for home directory (Unix-style)
  if (expanded.startsWith('~')) {
    try {
      const home = await invoke<string>('get_home_dir');
      expanded = expanded.replace(/^~/, home);
    } catch {
      // Fallback: try common Windows user profile
      expanded = expanded.replace(/^~/, '%USERPROFILE%');
    }
  }

  // Handle Windows environment variables like %USERPROFILE%
  const winEnvMatches = expanded.match(/%([^%]+)%/g);
  if (winEnvMatches) {
    for (const match of winEnvMatches) {
      const varName = match.slice(1, -1);
      try {
        const value = await invoke<string>('get_env_var', { name: varName });
        if (value) {
          expanded = expanded.replace(match, value);
        }
      } catch {
        // Leave as-is if variable not found
      }
    }
  }

  // Handle Unix environment variables like $HOME
  const unixEnvMatches = expanded.match(/\$([A-Za-z_][A-Za-z0-9_]*)/g);
  if (unixEnvMatches) {
    for (const match of unixEnvMatches) {
      const varName = match.slice(1);
      try {
        const value = await invoke<string>('get_env_var', { name: varName });
        if (value) {
          expanded = expanded.replace(match, value);
        }
      } catch {
        // Leave as-is if variable not found
      }
    }
  }

  return expanded;
}

/**
 * GoToFolderDialog - Modal for navigating to a specific folder path
 * Features: autocomplete, environment variables, recent paths
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
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Determine platform
  const isWindows = useMemo(() => {
    return typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
  }, []);

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

      // Check if typing an environment variable
      const envMatch = value.match(/(%[^%]*$)|(\$[A-Za-z_][A-Za-z0-9_]*$)|(^\$)$|(^~$)/);
      if (envMatch) {
        const envVars = COMMON_ENV_VARS.filter((e) =>
          isWindows ? e.platform === 'win32' : e.platform === 'unix'
        )
          .filter((e) => e.var.toLowerCase().startsWith(value.toLowerCase()) || value === '~')
          .map((e) => ({
            path: e.var,
            name: `${e.var} - ${e.desc}`,
            isDir: true,
            type: 'env' as const,
          }));
        setSuggestions(envVars);
        setShowSuggestions(envVars.length > 0);
        return;
      }

      try {
        // Expand environment variables first
        const expandedPath = await expandEnvironmentVariables(value);

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
    [currentPath, isWindows]
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
        // Expand environment variables
        const expandedPath = await expandEnvironmentVariables(inputValue.trim());

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

  const handleSelectSuggestion = useCallback(
    (suggestion: Suggestion) => {
      if (suggestion.type === 'env') {
        // For env vars, replace from the $ or % character
        const lastEnvStart = Math.max(
          inputValue.lastIndexOf('%'),
          inputValue.lastIndexOf('$'),
          inputValue === '~' ? 0 : -1
        );
        if (lastEnvStart >= 0) {
          setInputValue(inputValue.slice(0, lastEnvStart) + suggestion.path);
        } else {
          setInputValue(suggestion.path);
        }
      } else {
        setInputValue(suggestion.path);
      }
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
      inputRef.current?.focus();
    },
    [inputValue]
  );

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
      <div className={styles.dialog}>
        <h2 className={styles.title}>Go to Folder</h2>
        <form onSubmit={handleSubmit}>
          <div className={styles.inputContainer}>
            <input
              ref={inputRef}
              type="text"
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
              <div className={styles.suggestions} ref={suggestionsRef}>
                {suggestions.map((suggestion, index) => (
                  <div
                    key={`${suggestion.type}-${suggestion.path}`}
                    className={`${styles.suggestionItem} ${index === selectedSuggestionIndex ? styles.suggestionSelected : ''}`}
                    onClick={() => handleSelectSuggestion(suggestion)}
                    onMouseEnter={() => setSelectedSuggestionIndex(index)}
                  >
                    <span className={styles.suggestionIcon}>
                      {suggestion.type === 'recent'
                        ? '🕒'
                        : suggestion.type === 'env'
                          ? '📍'
                          : '📁'}
                    </span>
                    <span className={styles.suggestionText}>
                      {suggestion.type === 'env' ? suggestion.name : suggestion.path}
                    </span>
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
            <span className={styles.hintSecondary}>
              Supports: {isWindows ? '%USERPROFILE%, %APPDATA%' : '~, $HOME'} and more
            </span>
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
