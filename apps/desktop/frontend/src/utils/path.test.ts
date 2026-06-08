import { describe, expect, it } from 'vitest';
import {
  basename,
  buildPathStack,
  extname,
  filterSystemFiles,
  getParentPath,
  getPathRoot,
  isChildPath,
  isDriveRoot,
  isDSStore,
  isResourceFork,
  isRootPath,
  isSystemHiddenFile,
  isUNCPath,
  isUNCRoot,
  isWindowsReservedName,
  joinPaths,
  normalizePath,
  normalizePathForCompare,
  normalizeUNCPath,
  parseUNCPath,
  pathStartsWith,
  pathsEqual,
  relativePath,
  stripTrailingSeparator,
} from './path';

describe('path normalization', () => {
  it('normalizes empty, Windows, Unix, and UNC paths', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePathForCompare('C:\\Users\\Ada\\')).toBe('C:/Users/Ada');
    expect(normalizePath('c:\\Users\\Ada\\')).toBe('C:/Users/Ada');
    expect(normalizePath('d:')).toBe('D:/');
    expect(normalizePath('/usr/local/')).toBe('/usr/local');
    expect(normalizeUNCPath('\\\\server\\share\\folder\\')).toBe('//server/share/folder');
  });

  it('extracts parent, base name, and extensions without crossing roots', () => {
    expect(getParentPath('/a/b/c.txt')).toBe('/a/b');
    expect(getParentPath('/')).toBe('/');
    expect(getParentPath('C:/')).toBe('C:/');
    expect(getParentPath('//server/share/folder/file.txt')).toBe('//server/share/folder');
    expect(getParentPath('//server/share')).toBe('//server/share');
    expect(stripTrailingSeparator('/a/b/')).toBe('/a/b');
    expect(basename('/a/b/file.txt')).toBe('file.txt');
    expect(basename('/a/b/')).toBe('b');
    expect(extname('/a/b/file.txt')).toBe('.txt');
    expect(extname('/a/b/.env')).toBe('');
  });

  it('joins path segments while preserving roots', () => {
    expect(joinPaths('/a/', '/b/', 'c')).toBe('/a/b/c');
    expect(joinPaths('c:\\', 'Users', 'Ada')).toBe('C:/Users/Ada');
    expect(joinPaths('/', 'var', 'log')).toBe('/var/log');
    expect(joinPaths()).toBe('');
    expect(joinPaths('', '')).toBe('/');
  });
});

describe('UNC paths', () => {
  it('detects, parses, and roots UNC paths', () => {
    expect(isUNCPath('\\\\server\\share')).toBe(true);
    expect(isUNCRoot('//server/share')).toBe(true);
    expect(isUNCRoot('//server/share/folder')).toBe(false);
    expect(parseUNCPath('//server/share/folder/file.txt')).toEqual({
      server: 'server',
      share: 'share',
      path: '/folder/file.txt',
    });
    expect(getPathRoot('//server/share/folder/file.txt')).toBe('//server/share');
  });

  it('builds breadcrumb stack entries for UNC roots and children', () => {
    expect(buildPathStack('//server/share/folder/file.txt')).toEqual([
      { name: '\\\\server\\share', path: '//server/share' },
      { name: 'folder', path: '//server/share/folder' },
      { name: 'file.txt', path: '//server/share/folder/file.txt' },
    ]);
  });
});

describe('path comparison', () => {
  it('compares paths with explicit case-sensitivity', () => {
    expect(pathsEqual('/Users/Ada/File.txt', '/users/ada/file.txt', false)).toBe(true);
    expect(pathsEqual('/Users/Ada/File.txt', '/users/ada/file.txt', true)).toBe(false);
    expect(pathStartsWith('/a/b/c', '/a/b', true)).toBe(true);
    expect(pathStartsWith('/a/bother/c', '/a/b', true)).toBe(false);
    expect(isChildPath('/a/b/c', '/a/b')).toBe(true);
    expect(isChildPath('/a/b', '/a/b')).toBe(false);
  });

  it('computes relative paths from common ancestors', () => {
    expect(relativePath('/a/b/c', '/a/d/e')).toBe('../../d/e');
    expect(relativePath('/a/b', '/a/b')).toBe('.');
  });
});

describe('system and root helpers', () => {
  it('detects system files and filters macOS metadata by default', () => {
    expect(isSystemHiddenFile('/tmp/.DS_Store')).toBe(true);
    expect(isSystemHiddenFile('._thumbnail')).toBe(true);
    expect(isSystemHiddenFile('desktop.ini')).toBe(true);
    expect(isDSStore('/tmp/.DS_Store')).toBe(true);
    expect(isResourceFork('/tmp/._thumbnail')).toBe(true);

    const files = [{ name: '.DS_Store' }, { path: '/tmp/._thumbnail' }, { name: 'keep.txt' }];
    expect(filterSystemFiles(files)).toEqual([{ name: 'keep.txt' }]);
    expect(filterSystemFiles(files, { showDSStore: true })).toEqual([
      { name: '.DS_Store' },
      { name: 'keep.txt' },
    ]);
  });

  it('detects Windows reserved names and root paths', () => {
    expect(isWindowsReservedName('CON.txt')).toBe(true);
    expect(isWindowsReservedName('/tmp/regular.txt')).toBe(false);
    expect(isDriveRoot('c:')).toBe(true);
    expect(isRootPath('/')).toBe(true);
    expect(isRootPath('C:/')).toBe(true);
    expect(isRootPath('//server/share')).toBe(true);
    expect(getPathRoot('C:/Users/Ada')).toBe('C:/');
    expect(getPathRoot('/usr/local/bin')).toBe('/');
  });

  it('builds breadcrumb stack entries for Windows, Unix, and relative paths', () => {
    expect(buildPathStack('C:/Users/Ada')).toEqual([
      { name: 'C:', path: 'C:/' },
      { name: 'Users', path: 'C:/Users' },
      { name: 'Ada', path: 'C:/Users/Ada' },
    ]);
    expect(buildPathStack('/usr/local')).toEqual([
      { name: '/', path: '/' },
      { name: 'usr', path: '/usr' },
      { name: 'local', path: '/usr/local' },
    ]);
    expect(buildPathStack('relative/path')).toEqual([
      { name: 'relative', path: 'relative' },
      { name: 'path', path: 'relative/path' },
    ]);
  });
});
