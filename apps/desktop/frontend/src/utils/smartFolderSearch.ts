import { invoke } from '@tauri-apps/api/core';
import { readFile } from './fs';
import { parseToMs } from './date';
import { basename, normalizePathForCompare } from './path';
import type { FileEntry, SmartFolderCriteria } from '../store';

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

type NameMatcher = (name: string) => boolean;

function buildNameMatcher(pattern?: string, useRegex?: boolean): NameMatcher | null {
  const raw = pattern?.trim();
  if (!raw) return null;
  if (useRegex) {
    try {
      const regex = new RegExp(raw, 'i');
      return (name: string) => regex.test(name);
    } catch {
      return null;
    }
  }
  const needle = raw.toLowerCase();
  return (name: string) => name.toLowerCase().includes(needle);
}

function normalizeExtensions(extensions?: string[]): string[] {
  if (!Array.isArray(extensions)) return [];
  return extensions
    .map((ext) => String(ext).trim().toLowerCase().replace(/^\./, ''))
    .filter((ext) => ext.length > 0);
}

function matchesExtension(entry: FileEntry, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  if (entry.is_dir) return false;
  const name = entry.name ?? basename(entry.path) ?? '';
  const parts = name.toLowerCase().split('.');
  if (parts.length < 2) return false;
  const ext = parts[parts.length - 1];
  return extensions.includes(ext);
}

function matchesType(entry: FileEntry, typeFilter?: SmartFolderCriteria['typeFilter']): boolean {
  if (!typeFilter || typeFilter === 'all') return true;
  if (typeFilter === 'files') return !entry.is_dir;
  if (typeFilter === 'folders') return entry.is_dir;
  return true;
}

function matchesSize(entry: FileEntry, min?: number, max?: number): boolean {
  if (entry.is_dir) return false;
  if (typeof min === 'number' && entry.size < min) return false;
  if (typeof max === 'number' && entry.size > max) return false;
  return true;
}

function matchesModified(entry: FileEntry, after?: number, before?: number): boolean {
  if (after == null && before == null) return true;
  const modifiedMs = parseToMs(entry.modified) ?? 0;
  if (typeof after === 'number' && modifiedMs < after) return false;
  if (typeof before === 'number' && modifiedMs > before) return false;
  return true;
}

async function matchesContent(entry: FileEntry, query?: string): Promise<boolean> {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  if (entry.is_dir) return false;
  if (entry.size > MAX_CONTENT_BYTES) return false;
  try {
    const text = await readFile(entry.path);
    return text.toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

async function listFiles(path: string): Promise<FileEntry[]> {
  try {
    const entries = await invoke<FileEntry[]>('list_files', { path, calc_dir_size: false });
    return entries.map((entry) => ({
      ...entry,
      name: entry.name ?? basename(entry.path) ?? entry.path,
    }));
  } catch {
    return [];
  }
}

async function matchesCriteria(
  entry: FileEntry,
  criteria: SmartFolderCriteria,
  nameMatcher: NameMatcher | null,
  excludeMatcher: NameMatcher | null,
  extensions: string[]
): Promise<boolean> {
  const name = entry.name ?? basename(entry.path) ?? '';
  if (excludeMatcher && excludeMatcher(name)) {
    return false;
  }

  const combineMode = criteria.combineMode === 'OR' ? 'OR' : 'AND';
  const checks: Array<() => Promise<boolean>> = [];

  if (nameMatcher) {
    checks.push(async () => nameMatcher(name));
  }
  if (criteria.typeFilter) {
    checks.push(async () => matchesType(entry, criteria.typeFilter));
  }
  if (extensions.length > 0) {
    checks.push(async () => matchesExtension(entry, extensions));
  }
  if (criteria.sizeMin != null || criteria.sizeMax != null) {
    checks.push(async () => matchesSize(entry, criteria.sizeMin, criteria.sizeMax));
  }
  if (criteria.modifiedAfter != null || criteria.modifiedBefore != null) {
    checks.push(async () =>
      matchesModified(entry, criteria.modifiedAfter, criteria.modifiedBefore)
    );
  }
  if (criteria.contentSearch?.trim()) {
    checks.push(async () => matchesContent(entry, criteria.contentSearch));
  }

  if (checks.length === 0) return true;

  if (combineMode === 'OR') {
    for (const check of checks) {
      if (await check()) return true;
    }
    return false;
  }

  for (const check of checks) {
    if (!(await check())) return false;
  }
  return true;
}

export async function runSmartFolderSearch(criteria: SmartFolderCriteria): Promise<FileEntry[]> {
  const searchPaths = Array.isArray(criteria.searchPaths)
    ? criteria.searchPaths.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];
  if (searchPaths.length === 0) return [];

  const recursive = criteria.recursive !== false;
  const nameMatcher = buildNameMatcher(criteria.namePattern, criteria.nameRegex);
  const excludeMatcher = buildNameMatcher(criteria.excludePattern, criteria.nameRegex);
  const extensions = normalizeExtensions(criteria.extensions);

  const results: FileEntry[] = [];
  const visitedPaths = new Set<string>();
  const resultPaths = new Set<string>();
  const pending: string[] = [...searchPaths];

  while (pending.length > 0) {
    const path = pending.shift();
    if (!path) continue;
    const normalized = normalizePathForCompare(path);
    if (visitedPaths.has(normalized)) continue;
    visitedPaths.add(normalized);

    const entries = await listFiles(path);
    for (const entry of entries) {
      const entryKey = normalizePathForCompare(entry.path);

      if (entry.is_dir && recursive && !visitedPaths.has(entryKey)) {
        pending.push(entry.path);
      }

      if (await matchesCriteria(entry, criteria, nameMatcher, excludeMatcher, extensions)) {
        if (!resultPaths.has(entryKey)) {
          resultPaths.add(entryKey);
          results.push(entry);
        }
      }
    }
  }

  return results;
}
