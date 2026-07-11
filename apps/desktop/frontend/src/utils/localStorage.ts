/**
 * Type-safe localStorage wrapper for explorie settings and state persistence.
 *
 * This module provides a centralized, strongly-typed interface for all localStorage
 * operations, eliminating scattered try/catch blocks and `any` casts throughout the codebase.
 */

import type { ViewMode } from '../components/ViewModeToggle';
import type { SortKey, SortDir } from '../components/FileTable';
import type {
  ThemeMode,
  AccentColor,
  Density,
  FontChoice,
  BorderRadius,
  FavoriteItem,
  Workspace,
  SmartFolder,
  ThemeSpec,
} from '../store/types';
import type { RemoteDriveProfile } from './remoteDrives';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Schema for all localStorage keys and their value types.
 * This serves as the single source of truth for localStorage structure.
 */
export interface LocalStorageSchema {
  // View & Layout
  'explorie:viewMode': ViewMode;
  'explorie:showHidden': boolean;
  'explorie:filterMode': 'all' | 'folders' | 'files';
  'explorie:showFolderSizes': boolean;
  'explorie:showPreviewPanel': boolean;
  'explorie:showStatusBar': boolean;
  'explorie:previewExecutableScripts': boolean;
  'explorie:confirmBeforeDelete': boolean;

  // Sorting
  'explorie:sortKey': SortKey;
  'explorie:sortDir': SortDir;

  // Theme & Appearance
  'explorie:theme': ThemeMode;
  'explorie:accent': AccentColor;
  'explorie:accentCustom': string;
  'explorie:density': Density;
  'explorie:uiScale': number;
  'explorie:listRowHeight': number;
  'explorie:gridMinWidth': number;
  'explorie:font': FontChoice;
  'explorie:fontCustom': string;
  'explorie:borderRadius': BorderRadius;
  'explorie:iconSize': number;
  'explorie:reduceMotion': boolean;
  'explorie:themes': Record<string, ThemeSpec>;

  // Navigation & Tabs
  'explorie:tabs': Array<{ id: string; path: string }>;
  'explorie:activeTabId': string;
  'explorie:currentPath': string;

  // Favorites & Workspaces
  'explorie:favorites': FavoriteItem[];
  'explorie:workspaces': Record<string, Workspace>;
  'explorie:lastWorkspaceId': string;
  'explorie:smartFolders': Record<string, SmartFolder>;
  'explorie:remoteDrives': RemoteDriveProfile[];

  // Undo/Redo
  'explorie:undoTimeoutMinutes': number;
}

/**
 * Keys that store primitive string values (no JSON parsing needed)
 */
type StringKeys = {
  [K in keyof LocalStorageSchema]: LocalStorageSchema[K] extends string ? K : never;
}[keyof LocalStorageSchema];

/**
 * Keys that store boolean values
 */
type BooleanKeys = {
  [K in keyof LocalStorageSchema]: LocalStorageSchema[K] extends boolean ? K : never;
}[keyof LocalStorageSchema];

/**
 * Keys that store number values
 */
type NumberKeys = {
  [K in keyof LocalStorageSchema]: LocalStorageSchema[K] extends number ? K : never;
}[keyof LocalStorageSchema];

/**
 * Keys that store JSON objects/arrays
 */
type JsonKeys = Exclude<keyof LocalStorageSchema, StringKeys | BooleanKeys | NumberKeys>;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if localStorage is available
 */
function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get a string value from localStorage
 */
export function getString<K extends StringKeys>(key: K): LocalStorageSchema[K] | null {
  if (!isStorageAvailable()) return null;
  try {
    return window.localStorage.getItem(key) as LocalStorageSchema[K] | null;
  } catch {
    return null;
  }
}

/**
 * Get a string value from localStorage with a default fallback
 */
export function getStringWithDefault<K extends StringKeys>(
  key: K,
  defaultValue: LocalStorageSchema[K]
): LocalStorageSchema[K] {
  const value = getString(key);
  return value !== null ? value : defaultValue;
}

/**
 * Get a boolean value from localStorage
 */
export function getBoolean<K extends BooleanKeys>(key: K): LocalStorageSchema[K] | null {
  if (!isStorageAvailable()) return null;
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return null;
    return (value === 'true') as LocalStorageSchema[K];
  } catch {
    return null;
  }
}

/**
 * Get a boolean value from localStorage with a default fallback
 */
export function getBooleanWithDefault<K extends BooleanKeys>(
  key: K,
  defaultValue: LocalStorageSchema[K]
): LocalStorageSchema[K] {
  const value = getBoolean(key);
  return value !== null ? value : defaultValue;
}

/**
 * Get a number value from localStorage
 */
export function getNumber<K extends NumberKeys>(key: K): LocalStorageSchema[K] | null {
  if (!isStorageAvailable()) return null;
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : (parsed as LocalStorageSchema[K]);
  } catch {
    return null;
  }
}

/**
 * Get a number value from localStorage with a default fallback
 */
export function getNumberWithDefault<K extends NumberKeys>(
  key: K,
  defaultValue: LocalStorageSchema[K]
): LocalStorageSchema[K] {
  const value = getNumber(key);
  return value !== null ? value : defaultValue;
}

/**
 * Get a JSON object/array from localStorage
 */
export function getJson<K extends JsonKeys>(key: K): LocalStorageSchema[K] | null {
  if (!isStorageAvailable()) return null;
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return null;
    return JSON.parse(value) as LocalStorageSchema[K];
  } catch {
    return null;
  }
}

/**
 * Get a JSON object/array from localStorage with a default fallback
 */
export function getJsonWithDefault<K extends JsonKeys>(
  key: K,
  defaultValue: LocalStorageSchema[K]
): LocalStorageSchema[K] {
  const value = getJson(key);
  return value !== null ? value : defaultValue;
}

/**
 * Set a string value in localStorage
 */
export function setString<K extends StringKeys>(key: K, value: LocalStorageSchema[K]): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a boolean value in localStorage
 */
export function setBoolean<K extends BooleanKeys>(key: K, value: LocalStorageSchema[K]): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a number value in localStorage
 */
export function setNumber<K extends NumberKeys>(key: K, value: LocalStorageSchema[K]): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a JSON object/array in localStorage
 */
export function setJson<K extends JsonKeys>(key: K, value: LocalStorageSchema[K]): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a key from localStorage
 */
export function remove<K extends keyof LocalStorageSchema>(key: K): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Convenience Type-Union Setters
// ============================================================================

/**
 * Set any value in localStorage (auto-detects type)
 */
export function set<K extends keyof LocalStorageSchema>(
  key: K,
  value: LocalStorageSchema[K]
): boolean {
  if (!isStorageAvailable()) return false;
  try {
    if (typeof value === 'string') {
      window.localStorage.setItem(key, value);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      window.localStorage.setItem(key, String(value));
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get any value from localStorage (requires providing expected type info)
 */
export function get<K extends keyof LocalStorageSchema>(
  key: K,
  type: 'string' | 'boolean' | 'number' | 'json'
): LocalStorageSchema[K] | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;

    switch (type) {
      case 'string':
        return raw as LocalStorageSchema[K];
      case 'boolean':
        return (raw === 'true') as LocalStorageSchema[K];
      case 'number': {
        const n = parseFloat(raw);
        return isNaN(n) ? null : (n as LocalStorageSchema[K]);
      }
      case 'json':
        return JSON.parse(raw) as LocalStorageSchema[K];
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ============================================================================
// Storage Event Listener
// ============================================================================

type StorageChangeCallback<K extends keyof LocalStorageSchema> = (
  newValue: LocalStorageSchema[K] | null,
  oldValue: LocalStorageSchema[K] | null
) => void;

/**
 * Subscribe to changes for a specific localStorage key
 * Returns an unsubscribe function
 */
export function subscribe<K extends keyof LocalStorageSchema>(
  key: K,
  callback: StorageChangeCallback<K>,
  type: 'string' | 'boolean' | 'number' | 'json'
): () => void {
  if (!isStorageAvailable()) return () => {};

  const handler = (event: StorageEvent) => {
    if (event.key !== key) return;

    const parseValue = (raw: string | null): LocalStorageSchema[K] | null => {
      if (raw === null) return null;
      try {
        switch (type) {
          case 'string':
            return raw as LocalStorageSchema[K];
          case 'boolean':
            return (raw === 'true') as LocalStorageSchema[K];
          case 'number': {
            const n = parseFloat(raw);
            return isNaN(n) ? null : (n as LocalStorageSchema[K]);
          }
          case 'json':
            return JSON.parse(raw) as LocalStorageSchema[K];
          default:
            return null;
        }
      } catch {
        return null;
      }
    };

    callback(parseValue(event.newValue), parseValue(event.oldValue));
  };

  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
