import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../store';
import { describeFileEntry, formatItemCount, summarizeFailedItems } from './fileOperationFormat';

const file: FileEntry = {
  id: 'a',
  path: '/root/report.txt',
  name: 'report.txt',
  size: 100,
  modified: 1,
  is_dir: false,
  custom: {},
};

describe('fileOperationFormat', () => {
  it('describes file entries consistently', () => {
    expect(describeFileEntry(file)).toEqual({
      path: '/root/report.txt',
      name: 'report.txt',
      isDir: false,
    });
    expect(describeFileEntry({ ...file, name: undefined })).toMatchObject({
      name: 'report.txt',
    });
  });

  it('formats singular and plural item counts', () => {
    expect(formatItemCount(1, 'report.txt')).toBe('report.txt');
    expect(formatItemCount(3, 'report.txt')).toBe('3 items');
  });

  it('summarizes failed item names with overflow count', () => {
    expect(
      summarizeFailedItems([
        { name: 'a.txt', error: 'denied' },
        { name: 'b.txt', error: 'denied' },
        { name: 'c.txt', error: 'denied' },
        { name: 'd.txt', error: 'denied' },
      ])
    ).toBe('a.txt, b.txt, c.txt and 1 more');
  });
});
