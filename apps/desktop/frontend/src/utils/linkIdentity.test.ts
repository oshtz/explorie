import { describe, expect, it } from 'vitest';
import {
  entryAriaSuffix,
  entryDisplayTitle,
  getLinkKind,
  isDanglingLink,
  isLinkEntry,
} from './linkIdentity';

describe('linkIdentity', () => {
  it('treats ordinary files as neither links nor dangling', () => {
    const file = { is_symlink: false, is_junction: false, has_xattrs: false };
    expect(getLinkKind(file)).toBeNull();
    expect(isLinkEntry(file)).toBe(false);
    expect(isDanglingLink(file)).toBe(false);
    expect(entryDisplayTitle('notes.txt', file)).toBe('notes.txt');
    expect(entryAriaSuffix(file)).toBe('');
  });

  it('labels symlinks and surfaces the target', () => {
    const file = { is_symlink: true, link_target: '/tmp/real.txt' };
    expect(getLinkKind(file)).toBe('symlink');
    expect(entryDisplayTitle('alias.txt', file)).toContain('/tmp/real.txt');
    expect(entryAriaSuffix(file)).toContain('symbolic link to /tmp/real.txt');
  });

  it('labels junctions separately from symlinks', () => {
    const file = { is_junction: true, link_target: 'D:\\share' };
    expect(getLinkKind(file)).toBe('junction');
    expect(entryDisplayTitle('docs', file)).toContain('Junction → D:\\share');
    expect(entryAriaSuffix(file)).toContain('junction to D:\\share');
  });

  it('marks a missing target as dangling without treating xattrs as the file', () => {
    const file = { is_symlink: true, has_xattrs: true };
    expect(isDanglingLink(file)).toBe(true);
    expect(entryDisplayTitle('broken', file)).toContain('dangling target');
    expect(entryDisplayTitle('broken', file)).toContain('Extended attributes on this item');
    expect(entryAriaSuffix(file)).toContain('dangling symbolic link');
    expect(entryAriaSuffix(file)).toContain('has extended attributes');
  });
});
