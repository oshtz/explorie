import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import {
  MAX_CONTENT_BYTES,
  clearContentIndex,
  flushContentIndexToStorage,
  getContentIndexSize,
  hydrateContentIndexFromStorage,
  invalidateContentIndexForPaths,
  lookupIndexedText,
  registerContentIndexRoots,
  resetContentSearchIndex,
  seedContentIndex,
  setContentIndexStorage,
  takeContentIndexOpenCount,
  type ContentIndexSnapshot,
  type ContentIndexStorage,
} from './contentSearchIndex';

vi.mock('./fs', () => ({
  readFile: vi.fn(),
}));

const file = (path: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  id: path,
  path,
  name: path.split('/').pop() ?? path,
  size: 32,
  modified: '2026-01-15T12:00:00Z',
  hidden: false,
  is_dir: false,
  custom: {},
  ...overrides,
});

function memoryStorage(): ContentIndexStorage & { dumped: ContentIndexSnapshot | null } {
  const store: ContentIndexStorage & { dumped: ContentIndexSnapshot | null } = {
    dumped: null,
    async load() {
      return store.dumped;
    },
    async save(snapshot) {
      store.dumped = snapshot;
    },
    async clear() {
      store.dumped = null;
    },
  };
  return store;
}

describe('contentSearchIndex', () => {
  let readFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetContentSearchIndex();
    const fs = await import('./fs');
    readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockReset();
    readFileMock.mockResolvedValue('The secret phrase is here');
  });

  it('hits indexed text without rereading and misses absent needles', async () => {
    registerContentIndexRoots(['/workspace']);
    const entry = file('/workspace/notes.txt');

    await expect(lookupIndexedText(entry)).resolves.toContain('secret phrase');
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(takeContentIndexOpenCount()).toBe(1);

    await expect(lookupIndexedText(entry)).resolves.toContain('secret phrase');
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(takeContentIndexOpenCount()).toBe(0);

    const text = await lookupIndexedText(entry);
    expect(text?.includes('secret phrase')).toBe(true);
    expect(text?.includes('missing token')).toBe(false);
  });

  it('skips oversize files without opening them', async () => {
    registerContentIndexRoots(['/workspace']);
    const huge = file('/workspace/huge.txt', { size: MAX_CONTENT_BYTES + 1 });

    await expect(lookupIndexedText(huge)).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(takeContentIndexOpenCount()).toBe(0);
  });

  it('does not index paths outside opened or smart-folder roots', async () => {
    registerContentIndexRoots(['/workspace']);
    await expect(lookupIndexedText(file('/other/secret.txt'))).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('invalidates after an external edit and rereads on the next lookup', async () => {
    registerContentIndexRoots(['/workspace']);
    const entry = file('/workspace/notes.txt');

    await lookupIndexedText(entry);
    expect(readFileMock).toHaveBeenCalledTimes(1);

    invalidateContentIndexForPaths(['/workspace/notes.txt']);
    readFileMock.mockResolvedValue('updated body');

    await expect(lookupIndexedText(entry)).resolves.toBe('updated body');
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it('queries a 10k-file fixture from the index without opening every file', async () => {
    registerContentIndexRoots(['/workspace']);
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      file(`/workspace/f${index}.txt`, { size: 16 })
    );
    for (const entry of entries) {
      const hit = entry.path.endsWith('f7.txt') || entry.path.endsWith('f99.txt');
      seedContentIndex(entry.path, {
        size: entry.size,
        modifiedMs: Date.parse('2026-01-15T12:00:00Z'),
        status: 'ready',
        textLower: hit ? 'needle in a haystack' : 'padding',
      });
    }

    const hits: string[] = [];
    for (const entry of entries) {
      const text = await lookupIndexedText(entry);
      if (text?.includes('needle')) hits.push(entry.path);
    }

    expect(hits).toEqual(['/workspace/f7.txt', '/workspace/f99.txt']);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(takeContentIndexOpenCount()).toBe(0);
    expect(getContentIndexSize()).toBe(10_000);
  });

  it('persists to wipeable storage and restores after reset', async () => {
    const disk = memoryStorage();
    setContentIndexStorage(disk);
    registerContentIndexRoots(['/workspace']);
    await lookupIndexedText(file('/workspace/notes.txt'));
    await flushContentIndexToStorage();
    expect(disk.dumped?.records['/workspace/notes.txt']?.textLower).toContain('secret phrase');

    resetContentSearchIndex();
    setContentIndexStorage(disk);
    await hydrateContentIndexFromStorage();
    registerContentIndexRoots(['/workspace']);

    await expect(lookupIndexedText(file('/workspace/notes.txt'))).resolves.toContain(
      'secret phrase'
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);

    await clearContentIndex();
    expect(disk.dumped).toBeNull();
  });
});
