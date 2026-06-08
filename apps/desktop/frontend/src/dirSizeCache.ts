// Simple in-memory cache for directory sizes
const CACHE_MAX_ENTRIES = 750;
const CACHE_MAX_IDLE_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

type CacheEntry = {
  size: number;
  lastAccess: number;
};

const cache = new Map<string, CacheEntry>();
let cleanupTimer: number | null = null;

function scheduleCleanup(): void {
  if (cleanupTimer || typeof window === 'undefined') return;
  cleanupTimer = window.setInterval(() => {
    pruneCache();
  }, CLEANUP_INTERVAL_MS);
}

function touchEntry(path: string, entry: CacheEntry, now: number): void {
  entry.lastAccess = now;
  cache.delete(path);
  cache.set(path, entry);
}

function pruneCache(now = Date.now()): void {
  if (cache.size === 0) return;
  for (const [key, entry] of Array.from(cache.entries())) {
    if (now - entry.lastAccess > CACHE_MAX_IDLE_MS) {
      cache.delete(key);
    }
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function getCachedDirSize(path: string): number | undefined {
  const entry = cache.get(path);
  if (!entry) return undefined;
  const now = Date.now();
  if (now - entry.lastAccess > CACHE_MAX_IDLE_MS) {
    cache.delete(path);
    return undefined;
  }
  touchEntry(path, entry, now);
  return entry.size;
}

export function setCachedDirSize(path: string, size: number): void {
  const now = Date.now();
  cache.set(path, { size, lastAccess: now });
  scheduleCleanup();
  pruneCache(now);
}

export function clearDirSizeCache(): void {
  cache.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function seedFromEntries(
  entries: { path: string; is_dir?: boolean; size?: number }[]
): void {
  const now = Date.now();
  let seeded = false;
  for (const e of entries) {
    if (e.is_dir && typeof e.size === 'number' && e.size > 0) {
      cache.set(e.path, { size: e.size, lastAccess: now });
      seeded = true;
    }
  }
  if (seeded) {
    scheduleCleanup();
    pruneCache(now);
  }
}
