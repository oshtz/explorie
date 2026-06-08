import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFinderTag,
  areFinderTagsAvailable,
  createFinderTagWithColor,
  FINDER_TAG_COLORS,
  FINDER_TAG_CSS_COLORS,
  getAppsForFile,
  getColorNameFromIndex,
  getFinderTagColors,
  getFinderTags,
  isMacOS,
  isOpenWithAvailable,
  isQuickLookAvailable,
  openWithApp,
  parseFinderTag,
  quickLook,
  removeFinderTag,
  revealInFileManager,
  setFinderTags,
} from './finderIntegration';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

describe('finderIntegration', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('detects macOS and returns false when platform detection fails', async () => {
    mocks.invoke.mockResolvedValueOnce('macos');

    await expect(isMacOS()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('get_platform');

    mocks.invoke.mockResolvedValueOnce('windows');
    await expect(isMacOS()).resolves.toBe(false);

    mocks.invoke.mockRejectedValueOnce(new Error('platform unavailable'));
    await expect(isMacOS()).resolves.toBe(false);
  });

  it('delegates native file manager and Quick Look actions to Tauri commands', async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await revealInFileManager('/tmp/file.txt');
    await quickLook('/tmp/file.txt');
    await openWithApp('/tmp/file.txt', 'Preview');

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'reveal_in_file_manager', {
      path: '/tmp/file.txt',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'quick_look', {
      path: '/tmp/file.txt',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'open_with_app', {
      path: '/tmp/file.txt',
      appName: 'Preview',
    });
  });

  it('reads and writes Finder tags while preserving existing values', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_finder_tags') return Promise.resolve(['Work', 'Red']);
      return Promise.resolve(undefined);
    });

    await expect(getFinderTags('/tmp/file.txt')).resolves.toEqual(['Work', 'Red']);

    await setFinderTags('/tmp/file.txt', ['Blue']);
    expect(mocks.invoke).toHaveBeenCalledWith('set_finder_tags', {
      path: '/tmp/file.txt',
      tags: ['Blue'],
    });

    await addFinderTag('/tmp/file.txt', 'Review');
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_finder_tags', {
      path: '/tmp/file.txt',
      tags: ['Work', 'Red', 'Review'],
    });

    mocks.invoke.mockClear();
    mocks.invoke.mockResolvedValueOnce(['Work', 'Review']);
    await addFinderTag('/tmp/file.txt', 'Review');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('get_finder_tags', {
      path: '/tmp/file.txt',
    });
  });

  it('removes one Finder tag and keeps the remaining tags', async () => {
    mocks.invoke.mockResolvedValueOnce(['Work', 'Review', 'Archive']);

    await removeFinderTag('/tmp/file.txt', 'Review');

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'get_finder_tags', {
      path: '/tmp/file.txt',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'set_finder_tags', {
      path: '/tmp/file.txt',
      tags: ['Work', 'Archive'],
    });
  });

  it('loads tag colors and application handlers from Tauri', async () => {
    const apps = [{ name: 'Preview', path: '/Applications/Preview.app', bundle_id: 'preview' }];
    mocks.invoke.mockResolvedValueOnce({ Red: 6, Blue: 4 }).mockResolvedValueOnce(apps);

    await expect(getFinderTagColors()).resolves.toEqual({ Red: 6, Blue: 4 });
    await expect(getAppsForFile('/tmp/file.txt')).resolves.toEqual(apps);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'get_finder_tag_colors');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'get_apps_for_file', {
      path: '/tmp/file.txt',
    });
  });

  it('parses and creates Finder color tag strings', () => {
    expect(parseFinderTag('Important\n6')).toEqual({ name: 'Important', colorIndex: 6 });
    expect(parseFinderTag('Important\nnot-a-number')).toEqual({
      name: 'Important',
      colorIndex: 0,
    });
    expect(parseFinderTag('Plain')).toEqual({ name: 'Plain', colorIndex: 0 });

    expect(getColorNameFromIndex(6)).toBe('Red');
    expect(getColorNameFromIndex(404)).toBe('None');

    expect(createFinderTagWithColor('Important', 'Red')).toBe('Important\n6');
    expect(createFinderTagWithColor('Plain', 'None')).toBe('Plain');
    expect(createFinderTagWithColor('Custom', 4)).toBe('Custom\n4');

    expect(FINDER_TAG_COLORS.Red).toBe(6);
    expect(FINDER_TAG_CSS_COLORS.Blue).toBe('#007AFF');
  });

  it('bases macOS-only feature availability on the current platform', async () => {
    mocks.invoke.mockResolvedValue('macos');

    await expect(isQuickLookAvailable()).resolves.toBe(true);
    await expect(areFinderTagsAvailable()).resolves.toBe(true);
    await expect(isOpenWithAvailable()).resolves.toBe(true);

    mocks.invoke.mockResolvedValue('windows');
    await expect(isQuickLookAvailable()).resolves.toBe(false);
  });
});
