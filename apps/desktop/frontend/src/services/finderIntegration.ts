/**
 * macOS Finder integration service
 * Provides Quick Look, Finder tags, and reveal in Finder functionality
 */

import { invoke } from '@tauri-apps/api/core';

// Finder tag colors (matching macOS Finder)
export const FINDER_TAG_COLORS = {
  None: 0,
  Gray: 1,
  Green: 2,
  Purple: 3,
  Blue: 4,
  Yellow: 5,
  Red: 6,
  Orange: 7,
} as const;

export type FinderTagColor = keyof typeof FINDER_TAG_COLORS;

// CSS colors for displaying Finder tags
export const FINDER_TAG_CSS_COLORS: Record<FinderTagColor, string> = {
  None: 'transparent',
  Gray: '#8E8E93',
  Green: '#34C759',
  Purple: '#AF52DE',
  Blue: '#007AFF',
  Yellow: '#FFCC00',
  Red: '#FF3B30',
  Orange: '#FF9500',
};

/**
 * Check if the current platform is macOS
 */
export async function isMacOS(): Promise<boolean> {
  try {
    const platform = await invoke<string>('get_platform');
    return platform === 'macos';
  } catch {
    return false;
  }
}

/**
 * Reveal a file or folder in the native file manager
 * - macOS: Opens Finder and selects the file
 * - Windows: Opens Explorer and selects the file
 */
export async function revealInFileManager(path: string): Promise<void> {
  await invoke('reveal_in_file_manager', { path });
}

/**
 * Open Quick Look preview for a file (macOS only)
 * Uses qlmanage to show the system Quick Look preview
 */
export async function quickLook(path: string): Promise<void> {
  await invoke('quick_look', { path });
}

/**
 * Get Finder tags for a file (macOS only)
 * Returns an array of tag names
 */
export async function getFinderTags(path: string): Promise<string[]> {
  return invoke<string[]>('get_finder_tags', { path });
}

/**
 * Set Finder tags for a file (macOS only)
 * @param path - Path to the file
 * @param tags - Array of tag names to set
 */
export async function setFinderTags(path: string, tags: string[]): Promise<void> {
  await invoke('set_finder_tags', { path, tags });
}

/**
 * Add a Finder tag to a file (macOS only)
 * Preserves existing tags
 */
export async function addFinderTag(path: string, tag: string): Promise<void> {
  const existing = await getFinderTags(path);
  if (!existing.includes(tag)) {
    await setFinderTags(path, [...existing, tag]);
  }
}

/**
 * Remove a Finder tag from a file (macOS only)
 */
export async function removeFinderTag(path: string, tag: string): Promise<void> {
  const existing = await getFinderTags(path);
  await setFinderTags(
    path,
    existing.filter((t) => t !== tag)
  );
}

/**
 * Get available Finder tag colors
 * Returns a mapping of color names to their index
 */
export async function getFinderTagColors(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>('get_finder_tag_colors');
}

/**
 * Parse a Finder tag with color
 * Finder tags can include a color suffix like "Important\n6" (where 6 = Red)
 */
export function parseFinderTag(tag: string): { name: string; colorIndex: number } {
  const parts = tag.split('\n');
  const name = parts[0];
  const colorIndex = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
  return { name, colorIndex };
}

/**
 * Get the color name from a color index
 */
export function getColorNameFromIndex(index: number): FinderTagColor {
  const entries = Object.entries(FINDER_TAG_COLORS) as [FinderTagColor, number][];
  const entry = entries.find(([, idx]) => idx === index);
  return entry ? entry[0] : 'None';
}

/**
 * Create a tag string with color for Finder
 * @param name - Tag name
 * @param color - Color name or index
 */
export function createFinderTagWithColor(name: string, color: FinderTagColor | number): string {
  const colorIndex = typeof color === 'number' ? color : FINDER_TAG_COLORS[color];
  if (colorIndex === 0) {
    return name;
  }
  return `${name}\n${colorIndex}`;
}

/**
 * Check if Quick Look is available (macOS only)
 */
export async function isQuickLookAvailable(): Promise<boolean> {
  return isMacOS();
}

/**
 * Check if Finder tags are available (macOS only)
 */
export async function areFinderTagsAvailable(): Promise<boolean> {
  return isMacOS();
}

/**
 * Application info for "Open With" functionality
 */
export interface AppInfo {
  name: string;
  path: string;
  bundle_id?: string | null;
}

/**
 * Open a file with a specific application (macOS only)
 * @param path - Path to the file
 * @param appName - Name of the application to use
 */
export async function openWithApp(path: string, appName: string): Promise<void> {
  await invoke('open_with_app', { path, appName });
}

/**
 * Get list of applications that can open a specific file type (macOS only)
 * @param path - Path to the file
 * @returns Array of application info objects
 */
export async function getAppsForFile(path: string): Promise<AppInfo[]> {
  return invoke<AppInfo[]>('get_apps_for_file', { path });
}

/**
 * Check if "Open With" functionality is available
 */
export async function isOpenWithAvailable(): Promise<boolean> {
  try {
    const platform = await invoke<string>('get_platform');
    return platform === 'macos' || platform === 'windows';
  } catch {
    return false;
  }
}
