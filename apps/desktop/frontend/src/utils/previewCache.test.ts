import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPreviewCache,
  getCachedPreview,
  previewCacheKey,
  setCachedPreview,
} from './previewCache';

describe('previewCache', () => {
  beforeEach(() => {
    clearPreviewCache();
  });

  it('stores and returns cached previews by path', () => {
    setCachedPreview('/images/a.png', 'data:image/png;base64,a');

    expect(getCachedPreview('/images/a.png')).toBe('data:image/png;base64,a');
    expect(getCachedPreview('/images/missing.png')).toBeUndefined();
  });

  it('updates existing entries without keeping stale values', () => {
    setCachedPreview('/images/a.png', 'old');
    setCachedPreview('/images/a.png', 'new');

    expect(getCachedPreview('/images/a.png')).toBe('new');
  });

  it('evicts least-recently-used entries when the entry limit is exceeded', () => {
    for (let i = 0; i < 64; i += 1) {
      setCachedPreview(`/images/${i}.png`, `preview-${i}`);
    }
    expect(getCachedPreview('/images/0.png')).toBe('preview-0');

    setCachedPreview('/images/64.png', 'preview-64');
    setCachedPreview('/images/65.png', 'preview-65');

    expect(getCachedPreview('/images/1.png')).toBeUndefined();
    expect(getCachedPreview('/images/0.png')).toBe('preview-0');
    expect(getCachedPreview('/images/65.png')).toBe('preview-65');
  });

  it('ignores previews larger than the byte budget and can be cleared', () => {
    const oversizedPreview = 'x'.repeat(32 * 1024 * 1024 + 1);

    setCachedPreview('/images/huge.png', oversizedPreview);
    expect(getCachedPreview('/images/huge.png')).toBeUndefined();

    setCachedPreview('/images/a.png', 'small');
    clearPreviewCache();
    expect(getCachedPreview('/images/a.png')).toBeUndefined();
  });

  it('changes identity when size or modified time changes', () => {
    const path = '/images/photo.png';
    const original = previewCacheKey(path, 12, 100);
    const resized = previewCacheKey(path, 24, 100);
    const rewritten = previewCacheKey(path, 12, 200);
    const objectModified = previewCacheKey(path, 12, { secs_since_epoch: 100 });

    expect(original).toBe('/images/photo.png:12:100');
    expect(resized).not.toBe(original);
    expect(rewritten).not.toBe(original);
    expect(objectModified).toBe(original);

    setCachedPreview(original, 'first');
    expect(getCachedPreview(resized)).toBeUndefined();
    expect(getCachedPreview(rewritten)).toBeUndefined();
    expect(getCachedPreview(original)).toBe('first');

    clearPreviewCache();
    expect(getCachedPreview(original)).toBeUndefined();
  });
});
