import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { openEntry, resolvedLinkTarget } from './links';

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: '/workspace/link',
    path: '/workspace/link',
    name: 'link',
    size: 1,
    modified: 0,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

describe('link helpers', () => {
  beforeEach(() => invoke.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('resolves relative targets lexically without requiring the target to exist', () => {
    expect(
      resolvedLinkTarget({ path: '/workspace/links/report', link_target: '../report.txt' })
    ).toBe('/workspace/report.txt');
    expect(resolvedLinkTarget({ path: 'C:/workspace/link', link_target: 'C:/data/reports' })).toBe(
      'C:/data/reports'
    );
    expect(resolvedLinkTarget({ path: '/workspace/link', link_target: '   ' })).toBeNull();
  });

  it('honors follow and do-not-follow when opening a directory link', async () => {
    const link = file({ is_symlink: true });
    const info = {
      kind: 'symlink_dir',
      target: '../docs',
      resolved_target: '/workspace/docs',
      target_exists: true,
      target_is_dir: true,
    };
    const onFolderOpen = vi.fn();
    const onError = vi.fn();

    invoke.mockResolvedValueOnce(info);
    await openEntry(link, { follow: true, onFolderOpen, onError });
    expect(onFolderOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/workspace/docs', is_dir: true })
    );

    invoke.mockResolvedValueOnce(info);
    await openEntry(link, { follow: false, onFolderOpen, onError });
    expect(onFolderOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/workspace/link', is_dir: true })
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a missing or unreadable target without throwing', async () => {
    const link = file({ is_symlink: true });
    const onFolderOpen = vi.fn();
    const onError = vi.fn();
    invoke.mockResolvedValueOnce({
      kind: 'symlink_file',
      target: 'missing.txt',
      resolved_target: '/workspace/missing.txt',
      target_exists: false,
      target_is_dir: false,
    });

    await expect(openEntry(link, { follow: true, onFolderOpen, onError })).resolves.toBeUndefined();
    expect(onFolderOpen).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Symbolic link target is missing', expect.any(Error));

    invoke.mockRejectedValueOnce(new Error('permission denied'));
    await expect(openEntry(link, { follow: true, onFolderOpen, onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith('Could not read link target', expect.any(Error));
  });
});
