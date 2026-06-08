import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry, SmartFolderCriteria } from '../store';
import { runSmartFolderSearch } from './smartFolderSearch';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./fs', () => ({
  readFile: vi.fn(),
}));

type MockInvoke = ReturnType<typeof vi.fn>;

const file = (path: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  id: path,
  path,
  name: path.split('/').pop() ?? path,
  size: 128,
  modified: '2026-01-15T12:00:00Z',
  hidden: false,
  is_dir: false,
  custom: {},
  ...overrides,
});

const folder = (path: string, overrides: Partial<FileEntry> = {}): FileEntry =>
  file(path, {
    size: 0,
    is_dir: true,
    ...overrides,
  });

const criteria = (overrides: Partial<SmartFolderCriteria> = {}): SmartFolderCriteria => ({
  searchPaths: ['/workspace'],
  ...overrides,
});

describe('runSmartFolderSearch', () => {
  let invokeMock: MockInvoke;
  let readFileMock: MockInvoke;

  beforeEach(async () => {
    const tauri = await import('@tauri-apps/api/core');
    const fs = await import('./fs');
    invokeMock = tauri.invoke as unknown as MockInvoke;
    readFileMock = fs.readFile as unknown as MockInvoke;
    invokeMock.mockReset();
    readFileMock.mockReset();
  });

  it('returns matching files from recursive search paths without revisiting duplicates', async () => {
    invokeMock.mockImplementation(async (_command: string, args: { path: string }) => {
      if (args.path === '/workspace') {
        return [
          folder('/workspace/docs'),
          file('/workspace/notes.txt'),
          file('/workspace/image.png'),
        ];
      }
      if (args.path === '/workspace/docs') {
        return [file('/workspace/docs/report.txt'), folder('/workspace')];
      }
      return [];
    });

    const results = await runSmartFolderSearch(
      criteria({
        namePattern: 'report',
        extensions: ['.txt'],
        typeFilter: 'files',
      })
    );

    expect(results.map((entry) => entry.path)).toEqual(['/workspace/docs/report.txt']);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith('list_files', {
      path: '/workspace',
      calc_dir_size: false,
    });
  });

  it('supports OR criteria and excludes names with the same regex mode', async () => {
    invokeMock.mockResolvedValue([
      file('/workspace/photo.raw', { size: 2_000 }),
      file('/workspace/photo.tmp', { size: 2_000 }),
      file('/workspace/readme.md', { size: 10 }),
    ]);

    const results = await runSmartFolderSearch(
      criteria({
        namePattern: 'photo|readme',
        nameRegex: true,
        excludePattern: '\\.tmp$',
        extensions: ['md'],
        sizeMin: 1_000,
        combineMode: 'OR',
        recursive: false,
      })
    );

    expect(results.map((entry) => entry.path)).toEqual([
      '/workspace/photo.raw',
      '/workspace/readme.md',
    ]);
  });

  it('applies type, size, extension, and modified date filters in AND mode', async () => {
    invokeMock.mockResolvedValue([
      folder('/workspace/folder-match', {
        modified: '2026-01-16T12:00:00Z',
      }),
      file('/workspace/report.md', {
        size: 512,
        modified: '2026-01-16T12:00:00Z',
      }),
      file('/workspace/report.txt', {
        size: 512,
        modified: '2026-01-16T12:00:00Z',
      }),
      file('/workspace/old-report.txt', {
        size: 512,
        modified: '2025-12-31T12:00:00Z',
      }),
      file('/workspace/large-report.txt', {
        size: 5_000,
        modified: '2026-01-16T12:00:00Z',
      }),
    ]);

    const results = await runSmartFolderSearch(
      criteria({
        namePattern: 'report',
        extensions: ['txt'],
        typeFilter: 'files',
        sizeMin: 100,
        sizeMax: 1_000,
        modifiedAfter: Date.parse('2026-01-01T00:00:00Z'),
        modifiedBefore: Date.parse('2026-02-01T00:00:00Z'),
        recursive: false,
      })
    );

    expect(results.map((entry) => entry.path)).toEqual(['/workspace/report.txt']);
  });

  it('matches file contents while skipping directories, large files, and read failures', async () => {
    invokeMock.mockResolvedValue([
      folder('/workspace/docs'),
      file('/workspace/small.txt', { size: 100 }),
      file('/workspace/large.txt', { size: 6 * 1024 * 1024 }),
      file('/workspace/broken.txt', { size: 100 }),
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith('small.txt')) return 'The secret phrase is here';
      throw new Error('unreadable');
    });

    const results = await runSmartFolderSearch(
      criteria({
        contentSearch: 'SECRET phrase',
        typeFilter: 'files',
        recursive: false,
      })
    );

    expect(results.map((entry) => entry.path)).toEqual(['/workspace/small.txt']);
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it('returns all entries when an invalid name regex removes the name filter', async () => {
    invokeMock.mockResolvedValue([file('/workspace/one.txt'), file('/workspace/two.md')]);

    const results = await runSmartFolderSearch(
      criteria({
        namePattern: '[',
        nameRegex: true,
        recursive: false,
      })
    );

    expect(results.map((entry) => entry.path)).toEqual(['/workspace/one.txt', '/workspace/two.md']);
  });

  it('returns an empty list for blank search paths or backend listing failures', async () => {
    await expect(runSmartFolderSearch(criteria({ searchPaths: [' '] }))).resolves.toEqual([]);

    invokeMock.mockRejectedValue(new Error('list failed'));
    await expect(runSmartFolderSearch(criteria())).resolves.toEqual([]);
  });
});
