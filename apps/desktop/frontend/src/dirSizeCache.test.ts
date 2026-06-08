import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDirSizeCache,
  getCachedDirSize,
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
});
