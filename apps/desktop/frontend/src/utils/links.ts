/**
 * Symbolic link and Windows junction helpers.
 *
 * Listings mark links with `is_symlink` / `is_junction`; everything that needs
 * the link's target reads it on demand, since targets change under us and a
 * listing is not the place to resolve every one of them.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../store';

export type LinkKind = 'symlink_file' | 'symlink_dir' | 'junction';

export interface LinkInfo {
  kind: LinkKind;
  /** Target exactly as stored in the link; may be relative. */
  target: string;
  /** Target resolved against the link's own directory. */
  resolved_target: string;
  target_exists: boolean;
  target_is_dir: boolean;
}

/** Whether an entry is a symbolic link or a Windows junction. */
export function isLink(file: FileEntry): boolean {
  return Boolean(file.is_symlink || file.is_junction);
}

/** Human-readable name for the kind of link an entry is. */
export function linkTypeLabel(file: FileEntry): string {
  return file.is_junction ? 'Junction' : 'Symbolic link';
}

/**
 * Resolve a relative link target against the directory containing the link.
 *
 * The listing payload intentionally keeps the target as stored by the
 * filesystem. Resolving it here lets every view show a useful destination,
 * including for dangling links (where canonicalization would fail).
 */
export function resolvedLinkTarget(file: Pick<FileEntry, 'path' | 'link_target'>): string | null {
  const target = file.link_target?.trim();
  if (!target) return null;

  const normalizedTarget = target.replace(/\\/g, '/');
  const linkPath = file.path.replace(/\\/g, '/');
  const isAbsolute = normalizedTarget.startsWith('/') || /^[A-Za-z]:\//.test(normalizedTarget);
  const parent = linkPath.slice(0, linkPath.lastIndexOf('/')) || '.';
  const combined = isAbsolute ? normalizedTarget : `${parent}/${normalizedTarget}`;

  const drive = combined.match(/^[A-Za-z]:\//)?.[0] ?? '';
  const isUnc = !drive && combined.startsWith('//');
  const prefix = drive || (isUnc ? '//' : combined.startsWith('/') ? '/' : '');
  const remainder = drive
    ? combined.slice(3)
    : isUnc
      ? combined.slice(2)
      : combined.replace(/^\/+/, '');
  const parts: string[] = [];

  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!prefix) parts.push(part);
      continue;
    }
    parts.push(part);
  }

  return `${prefix}${parts.join('/')}` || prefix || '.';
}

export function readLinkInfo(path: string): Promise<LinkInfo> {
  return invoke<LinkInfo>('read_link_info', { path });
}

export function setLinkTarget(path: string, target: string): Promise<void> {
  return invoke('set_link_target', { path, target });
}

type OpenEntryOptions = {
  /**
   * Whether this link resolves to its target. Ignored for entries that are not
   * links. Following a directory link navigates to the real folder; not
   * following browses through the link, so the path stays the user's own.
   */
  follow: boolean;
  onFolderOpen?: (folder: FileEntry) => void;
  onError: (message: string, error: unknown) => void;
};

/**
 * Open an entry the way the user asked for: folders navigate, files hand off
 * to the OS, and links do either depending on what they point at.
 */
export async function openEntry(file: FileEntry, options: OpenEntryOptions): Promise<void> {
  const { follow, onFolderOpen, onError } = options;

  if (!isLink(file)) {
    if (file.is_dir) {
      onFolderOpen?.(file);
      return;
    }
    try {
      await invoke('open_path', { path: file.path });
    } catch (error) {
      onError('Open failed', error);
    }
    return;
  }

  let info: LinkInfo;
  try {
    info = await readLinkInfo(file.path);
  } catch (error) {
    onError('Could not read link target', error);
    return;
  }

  if (!info.target_exists) {
    onError(
      `${linkTypeLabel(file)} target is missing`,
      new Error(`${info.resolved_target} no longer exists`)
    );
    return;
  }

  if (info.target_is_dir) {
    onFolderOpen?.({
      ...file,
      path: follow ? info.resolved_target : file.path,
      is_dir: true,
    });
    return;
  }

  try {
    await invoke('open_path', { path: follow ? info.resolved_target : file.path });
  } catch (error) {
    onError('Open failed', error);
  }
}
