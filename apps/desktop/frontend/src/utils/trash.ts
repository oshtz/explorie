import { invoke } from '@tauri-apps/api/core';
import { mkdir, stat } from '@tauri-apps/plugin-fs';
import { fileExists, joinPaths } from './fs';
import { normalizePath } from './path';
import type { SystemLocations } from '../hooks/useInitialPath';

export const TRASH_FOLDER_NAME = '.explorie-trash';

let cachedTrashPath: string | null = null;

export function buildTrashPath(homePath: string): string {
  return normalizePath(joinPaths(homePath, TRASH_FOLDER_NAME));
}

async function ensureDirectory(path: string): Promise<string | null> {
  try {
    if (await fileExists(path)) {
      const info = await stat(path);
      if (info.isDirectory) return path;
    }
    await mkdir(path, { recursive: true });
    return path;
  } catch {
    return null;
  }
}

export async function getTrashPath(): Promise<string | null> {
  if (cachedTrashPath) return cachedTrashPath;
  try {
    const locations = await invoke<SystemLocations>('list_system_locations');
    const home = typeof locations?.home === 'string' ? locations.home : '';
    if (!home) return null;
    const path = buildTrashPath(home);
    cachedTrashPath = path;
    return path;
  } catch {
    return null;
  }
}

export async function ensureTrashDir(): Promise<string | null> {
  const path = await getTrashPath();
  if (!path) return null;
  return ensureDirectory(path);
}

export async function ensureTrashDirForHome(homePath: string): Promise<string | null> {
  if (!homePath) return null;
  const path = buildTrashPath(homePath);
  cachedTrashPath = path;
  return ensureDirectory(path);
}

export function isTrashPath(path: string, trashPath?: string | null): boolean {
  const normalized = normalizePath(path);
  const base = trashPath ? normalizePath(trashPath) : null;
  if (base && (normalized === base || normalized.startsWith(`${base}/`))) {
    return true;
  }
  return normalized.includes(`/${TRASH_FOLDER_NAME}`);
}
