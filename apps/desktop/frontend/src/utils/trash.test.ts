import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  fileExists: vi.fn(),
  joinPaths: vi.fn((...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: mocks.mkdir,
  stat: mocks.stat,
}));

vi.mock('./fs', () => ({
  fileExists: mocks.fileExists,
  joinPaths: mocks.joinPaths,
}));

async function loadTrash() {
  return import('./trash');
}

describe('trash utilities', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.mkdir.mockReset();
    mocks.stat.mockReset();
    mocks.fileExists.mockReset();
    mocks.joinPaths.mockClear();
  });

  it('builds normalized trash paths', async () => {
    const { TRASH_FOLDER_NAME, buildTrashPath } = await loadTrash();

    expect(TRASH_FOLDER_NAME).toBe('.explorie-trash');
    expect(buildTrashPath('C:\\Users\\Test')).toBe('C:/Users/Test/.explorie-trash');
  });

  it('gets and caches the trash path from system locations', async () => {
    const { getTrashPath } = await loadTrash();
    mocks.invoke.mockResolvedValue({ home: '/Users/alex' });

    await expect(getTrashPath()).resolves.toBe('/Users/alex/.explorie-trash');
    await expect(getTrashPath()).resolves.toBe('/Users/alex/.explorie-trash');

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('list_system_locations');
  });

  it('returns null when system locations are missing or fail', async () => {
    const { getTrashPath } = await loadTrash();

    mocks.invoke.mockResolvedValueOnce({ home: '' });
    await expect(getTrashPath()).resolves.toBeNull();

    vi.resetModules();
    const freshTrash = await loadTrash();
    mocks.invoke.mockRejectedValueOnce(new Error('locations failed'));
    await expect(freshTrash.getTrashPath()).resolves.toBeNull();
  });

  it('ensures trash directories by reusing existing folders or creating missing ones', async () => {
    const { ensureTrashDirForHome } = await loadTrash();

    mocks.fileExists.mockResolvedValueOnce(true);
    mocks.stat.mockResolvedValueOnce({ isDirectory: true });
    await expect(ensureTrashDirForHome('/Users/alex')).resolves.toBe('/Users/alex/.explorie-trash');
    expect(mocks.mkdir).not.toHaveBeenCalled();

    mocks.fileExists.mockResolvedValueOnce(false);
    await expect(ensureTrashDirForHome('/Users/alex')).resolves.toBe('/Users/alex/.explorie-trash');
    expect(mocks.mkdir).toHaveBeenCalledWith('/Users/alex/.explorie-trash', {
      recursive: true,
    });
  });

  it('returns null when ensuring directories fails or home is empty', async () => {
    const { ensureTrashDirForHome } = await loadTrash();

    await expect(ensureTrashDirForHome('')).resolves.toBeNull();

    mocks.fileExists.mockRejectedValueOnce(new Error('stat failed'));
    await expect(ensureTrashDirForHome('/Users/alex')).resolves.toBeNull();
  });

  it('ensures the current trash path and recognizes trash descendants', async () => {
    const { ensureTrashDir, isTrashPath } = await loadTrash();
    mocks.invoke.mockResolvedValueOnce({ home: '/Users/alex' });
    mocks.fileExists.mockResolvedValueOnce(false);

    await expect(ensureTrashDir()).resolves.toBe('/Users/alex/.explorie-trash');

    expect(isTrashPath('/Users/alex/.explorie-trash', '/Users/alex/.explorie-trash')).toBe(true);
    expect(isTrashPath('/Users/alex/.explorie-trash/file.txt', '/Users/alex/.explorie-trash')).toBe(
      true
    );
    expect(isTrashPath('/other/.explorie-trash/file.txt')).toBe(true);
    expect(isTrashPath('/Users/alex/Documents/file.txt', '/Users/alex/.explorie-trash')).toBe(
      false
    );
  });
});
