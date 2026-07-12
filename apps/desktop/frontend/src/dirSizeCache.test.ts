import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDirSizeCache,
  getCachedDirSize,
  mergeDirectorySizes,
  seedFromEntries,
  setCachedDirSize,
} from './dirSizeCache';

describe('dirSizeCache', () => {
  beforeEach(() => {
    clearDirSizeCache();
  });

  it('stores and retrieves directory sizes', () => {
    setCachedDirSize('/tmp', 1234);
    expect(getCachedDirSize('/tmp')).toBe(1234);
  });

  it('expires entries after the idle timeout', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(0);
    setCachedDirSize('/cache', 42);
    nowSpy.mockReturnValue(10 * 60 * 1000 + 1);
    expect(getCachedDirSize('/cache')).toBeUndefined();
    nowSpy.mockRestore();
  });

  it('seeds cache from valid directory entries only', () => {
    seedFromEntries([
      { path: '/a', is_dir: true, size: 100 },
      { path: '/b', is_dir: false, size: 200 },
      { path: '/c', is_dir: true, size: 0 },
    ]);

    expect(getCachedDirSize('/a')).toBe(100);
    expect(getCachedDirSize('/b')).toBeUndefined();
    expect(getCachedDirSize('/c')).toBeUndefined();
  });

  it('merges a size batch without replacing unchanged entries or arrays', () => {
    const entries = [
      { id: 'a', size: 0 },
      { id: 'b', size: 5 },
    ];

    const merged = mergeDirectorySizes(entries, new Map([['a', 10]]));
    expect(merged).not.toBe(entries);
    expect(merged[0]).toEqual({ id: 'a', size: 10 });
    expect(merged[1]).toBe(entries[1]);
    expect(mergeDirectorySizes(merged, new Map([['a', 10]]))).toBe(merged);
  });
});
