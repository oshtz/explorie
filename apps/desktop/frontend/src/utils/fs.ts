/**
 * File system utilities using Tauri's fs plugin
 */
import {
  readTextFile,
  writeTextFile,
  readDir,
  exists,
  rename,
  mkdir,
  remove,
  readFile as readBinaryFile,
  writeFile as writeBinaryFile,
  stat,
} from '@tauri-apps/plugin-fs';
import { clearDirSizeCache } from '../dirSizeCache';
import { invoke } from '@tauri-apps/api/core';
import { basename, getParentPath, joinPaths } from './path';
import { validateFileName } from './fileName';
import { formatErrorMessage } from './errorMessages';
import type { CustomFields, CustomFieldValue } from './customFieldTypes';

export type { DirEntry } from '@tauri-apps/plugin-fs';

// Re-export the functions directly
export { readTextFile, writeTextFile, readDir, exists };

type ReadDirEntry = Awaited<ReturnType<typeof readDir>>[number] & {
  path?: string;
  name?: string;
};

// Re-export error formatting for convenience
export {
  formatErrorMessage,
  formatError,
  formatOperationError,
  createOperationErrorMessage,
} from './errorMessages';

function toFsError(error: unknown): Error {
  return new Error(formatErrorMessage(error));
}

function ensureValidFileName(name: string): string {
  const trimmed = name.trim();
  const result = validateFileName(trimmed);
  if (!result.valid) {
    throw new Error(`Invalid file name: ${result.reason}`);
  }
  return trimmed;
}

async function assertReadable(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    throw toFsError(error);
  }
}

async function assertWritableDir(dirPath: string): Promise<void> {
  try {
    const info = await stat(dirPath);
    if (!info.isDirectory) {
      throw new Error('Not a directory');
    }
    if (info.readonly) {
      throw new Error('Access denied');
    }
  } catch (error) {
    throw toFsError(error);
  }
}

async function assertWritableParent(path: string): Promise<void> {
  const parent = getParentPath(path);
  await assertWritableDir(parent);
}

/**
 * Read a text file and return its contents
 * @param path Path to the file
 * @returns The file contents as a string
 */
export async function readFile(path: string): Promise<string> {
  try {
    await assertReadable(path);
    return await readTextFile(path);
  } catch (error) {
    console.error(`Failed to read file at ${path}:`, error);
    throw toFsError(error);
  }
}

/**
 * Write text to a file
 * @param path Path to the file
 * @param contents Contents to write
 */
export async function writeFile(path: string, contents: string): Promise<void> {
  try {
    await assertWritableParent(path);
    await writeTextFile(path, contents);
  } catch (error) {
    console.error(`Failed to write to file at ${path}:`, error);
    throw toFsError(error);
  }
}

/**
 * Read directory contents
 * @param path Path to the directory
 * @returns Array of directory entries
 */
export async function listDirectory(path: string) {
  try {
    await assertReadable(path);
    return await readDir(path);
  } catch (error) {
    console.error(`Failed to read directory at ${path}:`, error);
    throw toFsError(error);
  }
}

/**
 * Check if file or directory exists
 * @param path Path to check
 * @returns True if the path exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch (error) {
    console.error(`Failed to check if path exists at ${path}:`, error);
    return false;
  }
}

// Re-export joinPaths from path.ts for backwards compatibility
export { joinPaths } from './path';

/**
 * Move a file or folder into a target directory (rename).
 * Preserves the original basename.
 */
export async function moveToFolder(sourcePath: string, targetDirPath: string): Promise<void> {
  await assertWritableParent(sourcePath);
  await assertWritableDir(targetDirPath);
  const name = basename(sourcePath);
  const dest = joinPaths(targetDirPath, name);
  try {
    await rename(sourcePath, dest);
  } catch (error) {
    throw toFsError(error);
  }
  // Any filesystem change can invalidate folder sizes; clear cache.
  try {
    clearDirSizeCache();
  } catch {}
}

/**
 * Rename a file or folder to a new base name inside its current parent directory.
 * Returns the destination path.
 */
export async function renamePath(sourcePath: string, newBaseName: string): Promise<string> {
  const parent = getParentPath(sourcePath);
  const sanitized = ensureValidFileName(newBaseName);
  const tryDest = joinPaths(parent, sanitized);
  let dest = tryDest;
  if (await fileExists(dest)) {
    const extMatch = sanitized.match(/(.*)(\.[^.]*)$/);
    const base = extMatch ? extMatch[1] : sanitized;
    const ext = extMatch ? extMatch[2] : '';
    let n = 2;
    while (await fileExists(dest)) {
      dest = joinPaths(parent, `${base} (${n})${ext}`);
      n += 1;
      if (n > 9999) throw new Error('Could not find unique name for rename');
    }
  }
  await assertWritableDir(parent);
  try {
    await rename(sourcePath, dest);
  } catch (error) {
    throw toFsError(error);
  }
  try {
    clearDirSizeCache();
  } catch {}
  return dest;
}

/**
 * Delete a file or directory. For directories, remove recursively by default.
 */
export async function deletePath(targetPath: string, recursive: boolean = true): Promise<void> {
  await assertWritableParent(targetPath);
  try {
    await remove(targetPath, { recursive });
  } catch (error) {
    throw toFsError(error);
  } finally {
    try {
      clearDirSizeCache();
    } catch {}
  }
}

/**
 * Find a unique path by appending " (n)" if needed.
 */
export async function uniquePath(baseDir: string, baseName: string): Promise<string> {
  const checkedName = ensureValidFileName(baseName);
  let n = 1;
  // Try without suffix first
  let p = joinPaths(baseDir, checkedName);
  // If file exists, try incrementing suffix
  while (await fileExists(p)) {
    n += 1;
    p = joinPaths(baseDir, `${checkedName} (${n})`);
    // Safety bail-out
    if (n > 9999) throw new Error('Could not find unique name');
  }
  return p;
}

/**
 * Create a folder with a unique default name under a directory.
 * Returns created folder path.
 */
export async function createFolderIn(dirPath: string, baseName = 'New Folder'): Promise<string> {
  const target = await uniquePath(dirPath, baseName);
  await assertWritableDir(dirPath);
  try {
    await mkdir(target);
  } catch (error) {
    throw toFsError(error);
  }
  try {
    clearDirSizeCache();
  } catch {}
  return target;
}

/**
 * Create a markdown note with a unique default name under a directory.
 * Returns created file path.
 */
export async function createNoteIn(dirPath: string, baseName = 'New Note.md'): Promise<string> {
  // If user passed a name without extension, add .md
  const ensureMd = (n: string) => (n.toLowerCase().endsWith('.md') ? n : `${n}.md`);
  const nameOnly = ensureValidFileName(ensureMd(baseName));
  let candidate = joinPaths(dirPath, nameOnly);
  if (await fileExists(candidate)) {
    // Strip extension and delegate to uniquePath on basename without ext
    const base = nameOnly.replace(/\.md$/i, '');
    const p = await uniquePath(dirPath, base);
    candidate = `${p}.md`;
  }
  await assertWritableDir(dirPath);
  try {
    await writeTextFile(candidate, '# New Note\n');
  } catch (error) {
    throw toFsError(error);
  }
  try {
    clearDirSizeCache();
  } catch {}
  return candidate;
}

/**
 * Create a simple Internet shortcut (.url) pointing to the given URL.
 * Returns created file path.
 */
export async function createWebsiteLinkIn(
  dirPath: string,
  url: string,
  baseName = 'New Link.url'
): Promise<string> {
  const ensureUrlExt = (n: string) => (n.toLowerCase().endsWith('.url') ? n : `${n}.url`);
  const nameOnly = ensureValidFileName(ensureUrlExt(baseName));
  let candidate = joinPaths(dirPath, nameOnly);
  if (await fileExists(candidate)) {
    const base = nameOnly.replace(/\.url$/i, '');
    const p = await uniquePath(dirPath, base);
    candidate = `${p}.url`;
  }
  const contents = `[InternetShortcut]\nURL=${url}\n`;
  await assertWritableDir(dirPath);
  try {
    await writeTextFile(candidate, contents);
  } catch (error) {
    throw toFsError(error);
  }
  try {
    clearDirSizeCache();
  } catch {}
  return candidate;
}

/**
 * Recursively copy a file or directory into a target directory.
 * Returns the created destination path.
 */
export async function copyPathToDir(sourcePath: string, targetDirPath: string): Promise<string> {
  await assertWritableDir(targetDirPath);
  let sourceInfo: Awaited<ReturnType<typeof stat>>;
  try {
    sourceInfo = await stat(sourcePath);
  } catch (error) {
    throw toFsError(error);
  }
  // Determine destination path with unique naming
  const srcName = basename(sourcePath);
  const destBase = srcName;
  let destPath = joinPaths(targetDirPath, destBase);
  if (await fileExists(destPath)) {
    // If file, preserve extension when uniquifying
    const m = destBase.match(/^(.*?)(\.[^.]*)?$/);
    const base = m ? m[1] || destBase : destBase;
    const ext = m ? m[2] || '' : '';
    let n = 2;
    while (await fileExists(destPath)) {
      destPath = joinPaths(targetDirPath, `${base} (${n})${ext}`);
      n += 1;
      if (n > 9999) throw new Error('Could not find unique name for copy');
    }
  }
  if (!sourceInfo.isDirectory) {
    try {
      const data = await readBinaryFile(sourcePath);
      await writeBinaryFile(destPath, data);
    } catch (error) {
      throw toFsError(error);
    }
    try {
      clearDirSizeCache();
    } catch {}
    return destPath;
  }
  // Directory: create and recurse
  try {
    await mkdir(destPath);
  } catch (error) {
    throw toFsError(error);
  }
  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(sourcePath);
  } catch (error) {
    throw toFsError(error);
  }
  for (const entry of entries as ReadDirEntry[]) {
    const childPath = entry.path || joinPaths(sourcePath, entry.name || '');
    if (!childPath) continue;
    await copyPathToDir(childPath, destPath);
  }
  try {
    clearDirSizeCache();
  } catch {}
  return destPath;
}

/**
 * Interface for custom fields schema for a directory
 */
export interface CustomFieldsSchema {
  [filename: string]: Record<string, CustomFieldValue>;
}

/**
 * Create or update an .explorie.json schema file for a directory
 * @param dirPath Path to the directory where .explorie.json should be created/updated
 * @param schema The custom fields schema to save
 */
export async function createExplorieSchemaBatch(
  dirPath: string,
  schema: CustomFieldsSchema
): Promise<void> {
  try {
    await invoke<void>('create_explorie_schema', { dir_path: dirPath, fields: schema });
  } catch (error) {
    console.error(`Failed to create .explorie.json schema at ${dirPath}:`, error);
    throw error;
  }
}

/**
 * Update custom fields for a specific file in a directory
 * @param dirPath Path to the directory containing the file and .explorie.json
 * @param fileName Name of the file to update custom fields for
 * @param customFields Object containing custom field key-value pairs
 */
export async function updateCustomFields(
  dirPath: string,
  fileName: string,
  customFields: CustomFields
): Promise<void> {
  try {
    await invoke<void>('update_custom_fields', {
      dir_path: dirPath,
      file_name: fileName,
      custom_fields: customFields,
    });
  } catch (error) {
    console.error(`Failed to update custom fields for ${fileName} at ${dirPath}:`, error);
    throw error;
  }
}

/**
 * Add or update a single custom field for a file
 * @param dirPath Path to the directory containing the file
 * @param fileName Name of the file to update
 * @param fieldName Name of the custom field
 * @param fieldValue Value of the custom field
 */
export async function updateSingleCustomField(
  dirPath: string,
  fileName: string,
  fieldName: string,
  fieldValue: CustomFieldValue
): Promise<void> {
  try {
    // First check if file already has custom fields to avoid overwriting
    interface ListFileEntry {
      path: string;
      custom?: CustomFields;
    }
    const files = await invoke<ListFileEntry[]>('list_files', { path: dirPath });
    const file = files.find((f) => f.path.split('/').pop() === fileName);

    if (!file) {
      throw new Error(`File ${fileName} not found in ${dirPath}`);
    }

    // Get existing custom fields and update just the one field
    const existingFields: CustomFields = file.custom || {};
    const updatedFields: CustomFields = {
      ...existingFields,
      [fieldName]: fieldValue,
    };

    await updateCustomFields(dirPath, fileName, updatedFields);
  } catch (error) {
    console.error(`Failed to update custom field ${fieldName} for ${fileName}:`, error);
    throw error;
  }
}
