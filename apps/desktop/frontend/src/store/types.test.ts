import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import type { FileEntry } from './types';

const fixtureJson = readFileSync(
  resolve(process.cwd(), '../../../crates/core/tests/fixtures/file_entry.json'),
  'utf8'
);

const frontendOnlyFileEntryKeys = new Set(['name', 'is_draft']);

function deserializeFileEntry(json: string): FileEntry {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('FileEntry fixture must be an object');
  }

  const entry = value as Record<string, unknown>;
  const modified = entry.modified;
  const validModified =
    typeof modified === 'string' ||
    typeof modified === 'number' ||
    (modified !== null &&
      typeof modified === 'object' &&
      typeof (modified as Record<string, unknown>).secs_since_epoch === 'number');

  if (
    typeof entry.id !== 'string' ||
    typeof entry.path !== 'string' ||
    typeof entry.size !== 'number' ||
    !validModified ||
    typeof entry.hidden !== 'boolean' ||
    typeof entry.is_dir !== 'boolean' ||
    !entry.custom ||
    typeof entry.custom !== 'object' ||
    Array.isArray(entry.custom) ||
    typeof entry.is_symlink !== 'boolean' ||
    typeof entry.is_junction !== 'boolean' ||
    typeof entry.link_target !== 'string' ||
    typeof entry.has_xattrs !== 'boolean'
  ) {
    throw new TypeError('FileEntry fixture does not match the TypeScript mirror');
  }

  return entry as unknown as FileEntry;
}

function fileEntryMirrorKeys(): string[] {
  const source = ts.createSourceFile(
    'types.ts',
    readFileSync(resolve(process.cwd(), 'src/store/types.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'FileEntry'
  );

  if (!declaration) throw new Error('FileEntry interface not found in store/types.ts');

  return declaration.members
    .map((member) => {
      if (!member.name) return undefined;
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return member.name.text;
      throw new Error('FileEntry contains an unsupported computed property');
    })
    .filter((key): key is string => key !== undefined && !frontendOnlyFileEntryKeys.has(key))
    .sort();
}

describe('FileEntry serde fixture', () => {
  it('deserializes with every optional link metadata field', () => {
    const entry = deserializeFileEntry(fixtureJson);

    expect(entry.is_symlink).toBe(true);
    expect(entry.is_junction).toBe(false);
    expect(entry.link_target).toBe('/fixtures/source.txt');
    expect(entry.has_xattrs).toBe(true);
  });

  it('has exactly the wire fields declared by the TypeScript mirror', () => {
    const fixture = JSON.parse(fixtureJson) as Record<string, unknown>;
    expect(Object.keys(fixture).sort()).toEqual(fileEntryMirrorKeys());
  });
});
