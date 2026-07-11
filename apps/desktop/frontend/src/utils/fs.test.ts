import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dirSizeCache', () => ({
  clearDirSizeCache: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('fs utils', () => {
  let readTextFileMock: ReturnType<typeof vi.fn>;
  let readDirMock: ReturnType<typeof vi.fn>;
  let existsMock: ReturnType<typeof vi.fn>;
  let statMock: ReturnType<typeof vi.fn>;
  let invokeMock: ReturnType<typeof vi.fn>;
  let clearDirSizeCacheMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fsPlugin = await import('@tauri-apps/plugin-fs');
    const apiCore = await import('@tauri-apps/api/core');
    const dirSizeCache = await import('../dirSizeCache');

    readTextFileMock = fsPlugin.readTextFile as unknown as ReturnType<typeof vi.fn>;
    readDirMock = fsPlugin.readDir as unknown as ReturnType<typeof vi.fn>;
    existsMock = fsPlugin.exists as unknown as ReturnType<typeof vi.fn>;
    statMock = fsPlugin.stat as unknown as ReturnType<typeof vi.fn>;
    invokeMock = apiCore.invoke as unknown as ReturnType<typeof vi.fn>;
    clearDirSizeCacheMock = dirSizeCache.clearDirSizeCache as unknown as ReturnType<typeof vi.fn>;

    for (const mock of [
      readTextFileMock,
      readDirMock,
      existsMock,
      statMock,
      invokeMock,
      clearDirSizeCacheMock,
    ]) {
      mock.mockReset();
    }
  });

  it('uses the scoped plugin only for reads', async () => {
    const { readFile, listDirectory, fileExists } = await import('./fs');
    statMock.mockResolvedValue({ isDirectory: true });
    readTextFileMock.mockResolvedValue('hello');
    readDirMock.mockResolvedValue([{ name: 'a.txt', path: '/dir/a.txt' }]);
    existsMock.mockResolvedValue(true);

    await expect(readFile('/dir/a.txt')).resolves.toBe('hello');
    await expect(listDirectory('/dir')).resolves.toEqual([{ name: 'a.txt', path: '/dir/a.txt' }]);
    await expect(fileExists('/dir/a.txt')).resolves.toBe(true);

    expect(readTextFileMock).toHaveBeenCalledWith('/dir/a.txt');
    expect(readDirMock).toHaveBeenCalledWith('/dir');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('routes every production mutation through a constrained native command', async () => {
    const { renamePath, deletePath, createFolderIn, createNoteIn, createWebsiteLinkIn } =
      await import('./fs');
    invokeMock
      .mockResolvedValueOnce('/source/renamed.txt')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('/dir/New Folder')
      .mockResolvedValueOnce('/dir/Meeting Notes.md')
      .mockResolvedValueOnce('/dir/Example.url');

    await expect(renamePath('/source/file.txt', 'renamed.txt')).resolves.toBe(
      '/source/renamed.txt'
    );
    await deletePath('/source/old.txt', true);
    await expect(createFolderIn('/dir')).resolves.toBe('/dir/New Folder');
    await expect(createNoteIn('/dir', 'Meeting Notes')).resolves.toBe('/dir/Meeting Notes.md');
    await expect(createWebsiteLinkIn('/dir', 'https://example.com', 'Example')).resolves.toBe(
      '/dir/Example.url'
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'rename_path', {
      sourcePath: '/source/file.txt',
      newBaseName: 'renamed.txt',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'delete_path_permanently', {
      path: '/source/old.txt',
      recursive: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'create_folder', {
      dirPath: '/dir',
      baseName: 'New Folder',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'create_note', {
      dirPath: '/dir',
      baseName: 'Meeting Notes.md',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'create_website_link', {
      dirPath: '/dir',
      baseName: 'Example.url',
      url: 'https://example.com',
    });
    expect(clearDirSizeCacheMock).toHaveBeenCalledTimes(5);
  });

  it('rejects invalid names before invoking native code', async () => {
    const { renamePath, createFolderIn } = await import('./fs');

    await expect(renamePath('/base/file.txt', '   ')).rejects.toThrow(
      'Invalid file name: Name cannot be empty'
    );
    await expect(createFolderIn('/base', 'folder/name')).rejects.toThrow(
      'Invalid file name: Name cannot contain path separators'
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('normalizes read and native mutation errors', async () => {
    const { readFile, fileExists, deletePath } = await import('./fs');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    statMock.mockRejectedValueOnce(new Error('missing'));
    await expect(readFile('/missing.txt')).rejects.toThrow('Missing');
    existsMock.mockRejectedValueOnce(new Error('permission denied'));
    await expect(fileExists('/restricted')).resolves.toBe(false);
    invokeMock.mockRejectedValueOnce('permission denied');
    await expect(deletePath('/restricted', true)).rejects.toThrow(/access denied/i);
    expect(clearDirSizeCacheMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
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
