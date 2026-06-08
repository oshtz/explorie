import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dirSizeCache', () => ({
  clearDirSizeCache: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('fs utils', () => {
  let readTextFileMock: ReturnType<typeof vi.fn>;
  let writeTextFileMock: ReturnType<typeof vi.fn>;
  let readDirMock: ReturnType<typeof vi.fn>;
  let existsMock: ReturnType<typeof vi.fn>;
  let renameMock: ReturnType<typeof vi.fn>;
  let mkdirMock: ReturnType<typeof vi.fn>;
  let removeMock: ReturnType<typeof vi.fn>;
  let readBinaryFileMock: ReturnType<typeof vi.fn>;
  let writeBinaryFileMock: ReturnType<typeof vi.fn>;
  let statMock: ReturnType<typeof vi.fn>;
  let invokeMock: ReturnType<typeof vi.fn>;
  let clearDirSizeCacheMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fsPlugin = await import('@tauri-apps/plugin-fs');
    const apiCore = await import('@tauri-apps/api/core');
    const dirSizeCache = await import('../dirSizeCache');

    readTextFileMock = fsPlugin.readTextFile as unknown as ReturnType<typeof vi.fn>;
    writeTextFileMock = fsPlugin.writeTextFile as unknown as ReturnType<typeof vi.fn>;
    readDirMock = fsPlugin.readDir as unknown as ReturnType<typeof vi.fn>;
    existsMock = fsPlugin.exists as unknown as ReturnType<typeof vi.fn>;
    renameMock = fsPlugin.rename as unknown as ReturnType<typeof vi.fn>;
    mkdirMock = fsPlugin.mkdir as unknown as ReturnType<typeof vi.fn>;
    removeMock = fsPlugin.remove as unknown as ReturnType<typeof vi.fn>;
    readBinaryFileMock = fsPlugin.readFile as unknown as ReturnType<typeof vi.fn>;
    writeBinaryFileMock = fsPlugin.writeFile as unknown as ReturnType<typeof vi.fn>;
    statMock = fsPlugin.stat as unknown as ReturnType<typeof vi.fn>;
    invokeMock = apiCore.invoke as unknown as ReturnType<typeof vi.fn>;
    clearDirSizeCacheMock = dirSizeCache.clearDirSizeCache as unknown as ReturnType<typeof vi.fn>;

    for (const mock of [
      readTextFileMock,
      writeTextFileMock,
      readDirMock,
      existsMock,
      renameMock,
      mkdirMock,
      removeMock,
      readBinaryFileMock,
      writeBinaryFileMock,
      statMock,
      invokeMock,
      clearDirSizeCacheMock,
    ]) {
      mock.mockReset();
    }
  });

  it('joins paths with normalized separators', async () => {
    const { joinPaths } = await import('./fs');
    expect(joinPaths('C:\\', 'Users', 'test')).toBe('C:/Users/test');
    expect(joinPaths('/a/', '/b/', 'c')).toBe('/a/b/c');
  });

  it('returns a unique path when collisions occur', async () => {
    const { uniquePath } = await import('./fs');
    existsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(uniquePath('/base', 'File')).resolves.toBe('/base/File (2)');
  });

  it('returns the base path when no collision exists', async () => {
    const { uniquePath } = await import('./fs');
    existsMock.mockResolvedValueOnce(false);
    await expect(uniquePath('/base', 'File')).resolves.toBe('/base/File');
  });

  it('reads, writes, and lists paths after access checks', async () => {
    const { readFile, writeFile, listDirectory } = await import('./fs');
    const dirInfo = { isDirectory: true, readonly: false };

    statMock.mockResolvedValue(dirInfo);
    readTextFileMock.mockResolvedValue('hello');
    readDirMock.mockResolvedValue([{ name: 'a.txt', path: '/dir/a.txt' }]);

    await expect(readFile('/dir/a.txt')).resolves.toBe('hello');
    await expect(writeFile('/dir/a.txt', 'updated')).resolves.toBeUndefined();
    await expect(listDirectory('/dir')).resolves.toEqual([{ name: 'a.txt', path: '/dir/a.txt' }]);

    expect(readTextFileMock).toHaveBeenCalledWith('/dir/a.txt');
    expect(writeTextFileMock).toHaveBeenCalledWith('/dir/a.txt', 'updated');
    expect(readDirMock).toHaveBeenCalledWith('/dir');
  });

  it('normalizes fs errors and returns false when exists fails', async () => {
    const { readFile, fileExists } = await import('./fs');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    statMock.mockRejectedValueOnce(new Error('missing'));
    await expect(readFile('/missing.txt')).rejects.toThrow('Missing');

    existsMock.mockRejectedValueOnce(new Error('permission denied'));
    await expect(fileExists('/restricted')).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('moves, renames, deletes, and clears directory size cache', async () => {
    const { moveToFolder, renamePath, deletePath } = await import('./fs');
    const dirInfo = { isDirectory: true, readonly: false };

    statMock.mockResolvedValue(dirInfo);
    renameMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);

    await moveToFolder('/source/file.txt', '/target');

    existsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(renamePath('/source/file.txt', 'renamed.txt')).resolves.toBe(
      '/source/renamed (2).txt'
    );

    await deletePath('/source/old.txt', false);

    expect(renameMock).toHaveBeenCalledWith('/source/file.txt', '/target/file.txt');
    expect(renameMock).toHaveBeenCalledWith('/source/file.txt', '/source/renamed (2).txt');
    expect(removeMock).toHaveBeenCalledWith('/source/old.txt', { recursive: false });
    expect(clearDirSizeCacheMock).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid generated names before touching the filesystem', async () => {
    const { uniquePath, renamePath } = await import('./fs');

    await expect(uniquePath('/base', 'folder/name')).rejects.toThrow(
      'Invalid file name: Name cannot contain path separators'
    );
    await expect(renamePath('/base/file.txt', '   ')).rejects.toThrow(
      'Invalid file name: Name cannot be empty'
    );

    expect(existsMock).not.toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('creates folders, notes, and website links with normalized default content', async () => {
    const { createFolderIn, createNoteIn, createWebsiteLinkIn } = await import('./fs');
    const dirInfo = { isDirectory: true, readonly: false };

    statMock.mockResolvedValue(dirInfo);
    existsMock.mockResolvedValue(false);
    mkdirMock.mockResolvedValue(undefined);
    writeTextFileMock.mockResolvedValue(undefined);

    await expect(createFolderIn('/dir')).resolves.toBe('/dir/New Folder');
    await expect(createNoteIn('/dir', 'Meeting Notes')).resolves.toBe('/dir/Meeting Notes.md');
    await expect(createWebsiteLinkIn('/dir', 'https://example.com', 'Example')).resolves.toBe(
      '/dir/Example.url'
    );

    expect(mkdirMock).toHaveBeenCalledWith('/dir/New Folder');
    expect(writeTextFileMock).toHaveBeenCalledWith('/dir/Meeting Notes.md', '# New Note\n');
    expect(writeTextFileMock).toHaveBeenCalledWith(
      '/dir/Example.url',
      '[InternetShortcut]\nURL=https://example.com\n'
    );
    expect(clearDirSizeCacheMock).toHaveBeenCalledTimes(3);
  });

  it('copies files and empty folders into a writable target directory', async () => {
    const { copyPathToDir } = await import('./fs');
    const dirInfo = { isDirectory: true, readonly: false };
    const fileInfo = { isDirectory: false, readonly: false };
    const data = new Uint8Array([1, 2, 3]);

    statMock.mockResolvedValueOnce(dirInfo).mockResolvedValueOnce(fileInfo);
    existsMock.mockResolvedValueOnce(false);
    readBinaryFileMock.mockResolvedValue(data);
    writeBinaryFileMock.mockResolvedValue(undefined);

    await expect(copyPathToDir('/src/file.bin', '/dest')).resolves.toBe('/dest/file.bin');
    expect(writeBinaryFileMock).toHaveBeenCalledWith('/dest/file.bin', data);

    statMock.mockResolvedValueOnce(dirInfo).mockResolvedValueOnce(dirInfo);
    existsMock.mockResolvedValueOnce(false);
    mkdirMock.mockResolvedValue(undefined);
    readDirMock.mockResolvedValue([]);

    await expect(copyPathToDir('/src/folder', '/dest')).resolves.toBe('/dest/folder');
    expect(mkdirMock).toHaveBeenCalledWith('/dest/folder');
    expect(clearDirSizeCacheMock).toHaveBeenCalledTimes(2);
  });

  it('delegates custom-field commands to Tauri invoke', async () => {
    const { createExplorieSchemaBatch, updateCustomFields, updateSingleCustomField } =
      await import('./fs');

    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ path: '/dir/file.txt', custom: { rating: 4 } }])
      .mockResolvedValueOnce(undefined);

    await createExplorieSchemaBatch('/dir', { 'file.txt': { rating: 4 } });
    await updateCustomFields('/dir', 'file.txt', { status: 'done' });
    await updateSingleCustomField('/dir', 'file.txt', 'tags', ['blue']);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_explorie_schema', {
      dir_path: '/dir',
      fields: { 'file.txt': { rating: 4 } },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'update_custom_fields', {
      dir_path: '/dir',
      file_name: 'file.txt',
      custom_fields: { status: 'done' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'list_files', { path: '/dir' });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'update_custom_fields', {
      dir_path: '/dir',
      file_name: 'file.txt',
      custom_fields: { rating: 4, tags: ['blue'] },
    });
  });

  it('rejects single custom-field updates when the file is missing', async () => {
    const { updateSingleCustomField } = await import('./fs');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    invokeMock.mockResolvedValueOnce([]);

    await expect(updateSingleCustomField('/dir', 'missing.txt', 'status', 'todo')).rejects.toThrow(
      'File missing.txt not found in /dir'
    );
    expect(errorSpy).toHaveBeenCalled();
  });
});
