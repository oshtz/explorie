/**
 * File system utilities using Tauri's fs plugin
 */
import { readTextFile, readDir, exists, stat } from '@tauri-apps/plugin-fs';
import { clearDirSizeCache } from '../dirSizeCache';
import { invoke } from '@tauri-apps/api/core';
import { validateFileName } from './fileName';
import { formatErrorMessage } from './errorMessages';
import type { CustomFields, CustomFieldValue } from './customFieldTypes';

export type { DirEntry } from '@tauri-apps/plugin-fs';

// Re-export the functions directly
export { readTextFile, readDir, exists };

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

async function invokeMutation<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    const result = await invoke<T>(command, args);
    clearDirSizeCache();
    return result;
  } catch (error) {
    throw toFsError(error);
  }
}

/**
 * Rename a file or folder to a new base name inside its current parent directory.
 * Returns the destination path.
 */
export async function renamePath(sourcePath: string, newBaseName: string): Promise<string> {
  return invokeMutation('rename_path', {
    sourcePath,
    newBaseName: ensureValidFileName(newBaseName),
  });
}

/**
 * Delete a file or directory. For directories, remove recursively by default.
 */
export async function deletePath(targetPath: string, recursive: boolean = true): Promise<void> {
  await invokeMutation('delete_path_permanently', { path: targetPath, recursive });
}

/**
 * Create a folder with a unique default name under a directory.
 * Returns created folder path.
 */
export async function createFolderIn(dirPath: string, baseName = 'New Folder'): Promise<string> {
  return invokeMutation('create_folder', {
    dirPath,
    baseName: ensureValidFileName(baseName),
  });
}

/**
 * Create a markdown note with a unique default name under a directory.
 * Returns created file path.
 */
export async function createNoteIn(dirPath: string, baseName = 'New Note.md'): Promise<string> {
  const ensureMd = (n: string) => (n.toLowerCase().endsWith('.md') ? n : `${n}.md`);
  return invokeMutation('create_note', {
    dirPath,
    baseName: ensureValidFileName(ensureMd(baseName)),
  });
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
  return invokeMutation('create_website_link', {
    dirPath,
    baseName: ensureValidFileName(ensureUrlExt(baseName)),
    url,
  });
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
