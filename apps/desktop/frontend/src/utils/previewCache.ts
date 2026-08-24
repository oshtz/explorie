type CacheEntry = {
  dataUrl: string;
  size: number;
};

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;

const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

function evictIfNeeded() {
  while (totalBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) return;
    const entry = cache.get(oldestKey);
    if (entry) {
      totalBytes = Math.max(0, totalBytes - entry.size);
    }
    cache.delete(oldestKey);
  }
}

export function getCachedPreview(path: string, identity = ''): string | undefined {
  const key = `${path}\0${identity}`;
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry.dataUrl;
}

export function setCachedPreview(path: string, dataUrl: string, identity = ''): void {
  const key = `${path}\0${identity}`;
  const size = dataUrl.length;
  if (size > MAX_CACHE_BYTES) return;

  const existing = cache.get(key);
  if (existing) {
    totalBytes = Math.max(0, totalBytes - existing.size);
    cache.delete(key);
  }

  cache.set(key, { dataUrl, size });
  totalBytes += size;
  evictIfNeeded();
}

export function clearPreviewCache(): void {
  cache.clear();
  totalBytes = 0;
}
