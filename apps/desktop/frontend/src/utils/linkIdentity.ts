import type { FileEntry } from '../store';

export type LinkKind = 'symlink' | 'junction';

export function getLinkKind(file: Pick<FileEntry, 'is_symlink' | 'is_junction'>): LinkKind | null {
  if (file.is_junction) return 'junction';
  if (file.is_symlink) return 'symlink';
  return null;
}

export function isLinkEntry(file: Pick<FileEntry, 'is_symlink' | 'is_junction'>): boolean {
  return getLinkKind(file) !== null;
}

export function isDanglingLink(
  file: Pick<FileEntry, 'is_symlink' | 'is_junction' | 'link_target'>
): boolean {
  return isLinkEntry(file) && !file.link_target;
}

export function linkKindLabel(kind: LinkKind): string {
  return kind === 'junction' ? 'Junction' : 'Symbolic link';
}

export function entryDisplayTitle(
  fileName: string,
  file: Pick<FileEntry, 'is_symlink' | 'is_junction' | 'link_target' | 'has_xattrs'>
): string {
  const lines = [fileName];
  const kind = getLinkKind(file);
  if (kind) {
    if (file.link_target) {
      lines.push(`${linkKindLabel(kind)} → ${file.link_target}`);
    } else {
      lines.push(`${linkKindLabel(kind)} (dangling target)`);
    }
  }
  if (file.has_xattrs) {
    lines.push('Extended attributes on this item');
  }
  return lines.join('\n');
}

export function entryAriaSuffix(
  file: Pick<FileEntry, 'is_symlink' | 'is_junction' | 'link_target' | 'has_xattrs'>
): string {
  const parts: string[] = [];
  const kind = getLinkKind(file);
  if (kind === 'junction') {
    parts.push(file.link_target ? `junction to ${file.link_target}` : 'dangling junction');
  } else if (kind === 'symlink') {
    parts.push(
      file.link_target ? `symbolic link to ${file.link_target}` : 'dangling symbolic link'
    );
  }
  if (file.has_xattrs) {
    parts.push('has extended attributes');
  }
  return parts.length ? `, ${parts.join(', ')}` : '';
}
