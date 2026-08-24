import { invoke } from '@tauri-apps/api/core';
import { parseToMs } from './date';
import { readFile } from './fs';
import { normalizePathForCompare, pathStartsWith } from './path';
import type { FileEntry } from '../store';

export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

export type ContentIndexStatus = 'ready' | 'oversize' | 'unreadable';

export type ContentIndexRecord = {
  size: number;
  modifiedMs: number;
  status: ContentIndexStatus;
  textLower: string | null;
};

export type ContentIndexSnapshot = {
  version: 1;
  records: Record<string, ContentIndexRecord>;
};

export type ContentIndexStorage = {
  load(): Promise<ContentIndexSnapshot | null>;
  save(snapshot: ContentIndexSnapshot): Promise<void>;
  clear(): Promise<void>;
};

const records = new Map<string, ContentIndexRecord>();
const allowedRoots = new Set<string>();

let storage: ContentIndexStorage | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let filesOpened = 0;

function indexKey(path: string): string {
  return normalizePathForCompare(path);
}

function rootKey(path: string): string {
  return normalizePathForCompare(path);
}

function entryIdentity(entry: FileEntry): { size: number; modifiedMs: number } {
  return {
    size: entry.size,
    modifiedMs: parseToMs(entry.modified) ?? -1,
  };
}

function isUnderAllowedRoot(path: string): boolean {
  if (allowedRoots.size === 0) return false;
  for (const root of allowedRoots) {
    if (pathStartsWith(path, root)) return true;
  }
  return false;
}

function snapshotRecords(): ContentIndexSnapshot {
  const dumped: Record<string, ContentIndexRecord> = {};
  for (const [key, record] of records) {
    dumped[key] = record;
  }
  return { version: 1, records: dumped };
}

function schedulePersist(): void {
  if (!storage) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void storage?.save(snapshotRecords());
  }, 250);
}

async function ensureHydrated(): Promise<void> {
  if (hydrated || !storage) {
    hydrated = true;
    return;
  }
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const snapshot = await storage?.load();
        if (snapshot?.version === 1 && snapshot.records) {
          for (const [key, record] of Object.entries(snapshot.records)) {
            if (!records.has(key)) records.set(key, record);
          }
        }
      } catch {
        // stay in-session
      } finally {
        hydrated = true;
        hydratePromise = null;
      }
    })();
  }
  await hydratePromise;
}

export function createTauriContentIndexStorage(): ContentIndexStorage {
  return {
    async load() {
      try {
        const raw = await invoke<string>('load_content_search_index');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ContentIndexSnapshot;
        if (parsed?.version !== 1 || typeof parsed.records !== 'object' || !parsed.records) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    async save(snapshot) {
      try {
        await invoke('save_content_search_index', { json: JSON.stringify(snapshot) });
      } catch {
        // in-session remains source of truth
      }
    },
    async clear() {
      try {
        await invoke('clear_content_search_index');
      } catch {
        //
      }
    },
  };
}

export function setContentIndexStorage(next: ContentIndexStorage | null): void {
  storage = next;
}

export function registerContentIndexRoots(paths: string[]): void {
  for (const path of paths) {
    if (typeof path !== 'string') continue;
    const trimmed = path.trim();
    if (!trimmed) continue;
    allowedRoots.add(rootKey(trimmed));
  }
}

export function seedContentIndex(path: string, record: ContentIndexRecord): void {
  records.set(indexKey(path), record);
}

export function invalidateContentIndexForPaths(paths: string[]): void {
  if (paths.length === 0) return;
  const keys = Array.from(records.keys());
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const normalized = indexKey(path);
    records.delete(normalized);
    for (const key of keys) {
      if (key === normalized || pathStartsWith(key, path)) {
        records.delete(key);
      }
    }
  }
  schedulePersist();
}

export async function clearContentIndex(): Promise<void> {
  records.clear();
  allowedRoots.clear();
  filesOpened = 0;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (storage) {
    try {
      await storage.clear();
    } catch {
      //
    }
  }
}

export function resetContentSearchIndex(): void {
  records.clear();
  allowedRoots.clear();
  filesOpened = 0;
  hydrated = true;
  hydratePromise = null;
  storage = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export function takeContentIndexOpenCount(): number {
  const count = filesOpened;
  filesOpened = 0;
  return count;
}

export function getContentIndexSize(): number {
  return records.size;
}

export async function hydrateContentIndexFromStorage(): Promise<void> {
  hydrated = false;
  await ensureHydrated();
}

export async function flushContentIndexToStorage(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!storage) return;
  await storage.save(snapshotRecords());
}

export async function lookupIndexedText(entry: FileEntry): Promise<string | null> {
  await ensureHydrated();
  if (entry.is_dir) return null;

  const key = indexKey(entry.path);
  const { size, modifiedMs } = entryIdentity(entry);

  if (size > MAX_CONTENT_BYTES) {
    records.set(key, { size, modifiedMs, status: 'oversize', textLower: null });
    schedulePersist();
    return null;
  }

  const cached = records.get(key);
  if (cached && cached.size === size && cached.modifiedMs === modifiedMs) {
    return cached.textLower;
  }

  if (!isUnderAllowedRoot(entry.path)) {
    return null;
  }

  filesOpened += 1;
  try {
    const textLower = (await readFile(entry.path)).toLowerCase();
    records.set(key, { size, modifiedMs, status: 'ready', textLower });
    schedulePersist();
    return textLower;
  } catch {
    records.set(key, { size, modifiedMs, status: 'unreadable', textLower: null });
    schedulePersist();
    return null;
  }
}
