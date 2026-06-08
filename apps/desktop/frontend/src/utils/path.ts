/**
 * Cross-platform path utilities for explorie file manager.
 *
 * This module provides a centralized, consistent API for path handling
 * across Windows and macOS platforms.
 */

// Detect platform at runtime
const isWindows =
  typeof navigator !== 'undefined'
    ? navigator.platform?.toLowerCase().includes('win')
    : typeof process !== 'undefined' && process.platform === 'win32';

const isMacOS =
  typeof navigator !== 'undefined'
    ? navigator.platform?.toLowerCase().includes('mac')
    : typeof process !== 'undefined' && process.platform === 'darwin';

// ============================================================================
// Constants
// ============================================================================

/** System files that should be hidden by default */
export const SYSTEM_HIDDEN_FILES: readonly string[] = [
  // macOS
  '.DS_Store',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
  '.VolumeIcon.icns',
  '._*', // macOS resource fork files
  // Windows
  'desktop.ini',
  'Thumbs.db',
  '$RECYCLE.BIN',
  'System Volume Information',
  // Cross-platform
  '.git',
  '.svn',
  '.hg',
];

/** Windows reserved file names (case-insensitive) */
const WINDOWS_RESERVED_NAMES = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

// ============================================================================
// Core Path Normalization
// ============================================================================

/**
 * Normalize a path for string comparison.
 * Converts backslashes to forward slashes and removes trailing separator.
 */
export function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * Normalize a path to a consistent format.
 * - Converts backslashes to forward slashes
 * - Handles Windows drive roots (uppercase)
 * - Handles UNC paths (\\server\share -> //server/share)
 * - Removes trailing slashes (except for roots)
 */
export function normalizePath(path: string): string {
  if (!path) return '/';

  // Handle UNC paths first (\\server\share or //server/share)
  if (isUNCPath(path)) {
    return normalizeUNCPath(path);
  }

  let normalized = path.replace(/\\/g, '/');

  // Handle Windows drive roots
  const driveMatch = normalized.match(/^[A-Za-z]:\/?$/);
  if (driveMatch) return `${normalized[0].toUpperCase()}:/`;

  // Remove trailing slash except for root paths
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/$/, '');
  }

  // Uppercase drive letter if present
  normalized = normalized.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);

  return normalized;
}

/**
 * Get the parent directory path.
 * Returns the root path if already at root.
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);

  // Handle UNC root (//server/share)
  if (isUNCRoot(normalized)) return normalized;

  // Handle drive root (C:/)
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;

  // Handle UNC path - don't go above share level
  const uncMatch = normalized.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (uncMatch) {
    const serverShare = `//${uncMatch[1]}/${uncMatch[2]}`;
    const rest = uncMatch[3];
    if (!rest || rest === '/') return serverShare;
    const parent = rest.replace(/\/[^/]+$/, '');
    return parent ? `${serverShare}${parent}` : serverShare;
  }

  return normalized.replace(/\/$/, '').replace(/[\\/][^\\/]+$/, '') || '/';
}

/**
 * Remove trailing path separator from a path.
 */
export function stripTrailingSeparator(path: string): string {
  return path.replace(/[/\\]$/, '');
}

/**
 * Get the base name (filename) from a path.
 */
export function basename(path: string): string {
  const trimmed = stripTrailingSeparator(path);
  return trimmed.split(/[/\\]/).pop() || trimmed || path;
}

/**
 * Get the file extension including the dot.
 * Returns empty string if no extension.
 */
export function extname(path: string): string {
  const name = basename(path);
  const dotIndex = name.lastIndexOf('.');
  // No dot, or dot at start (hidden file), or only dot
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex);
}

/**
 * Get the directory name (parent path) from a path.
 * Alias for getParentPath for Node.js compatibility.
 */
export const dirname = getParentPath;

/**
 * Join path segments using forward slashes.
 * Handles Windows drive roots and UNC paths correctly.
 */
export function joinPaths(...parts: string[]): string {
  if (parts.length === 0) return '';

  const segments: string[] = [];
  let hasRoot = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    let segment = String(part).replace(/\\+/g, '/');

    // Check if first segment is a root
    if (i === 0 || !hasRoot) {
      // UNC path
      if (segment.match(/^\/\//)) {
        hasRoot = true;
        segments.push(segment.replace(/\/+$/, ''));
        continue;
      }
      // Windows drive
      if (segment.match(/^[A-Za-z]:/)) {
        hasRoot = true;
        segment = segment.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
        segments.push(segment.replace(/\/+$/, ''));
        continue;
      }
      // Unix root "/" alone
      if (segment === '/') {
        hasRoot = true;
        segments.push('');
        continue;
      }
      // Unix path starting with / (e.g., "/a" or "/a/b")
      if (segment.startsWith('/')) {
        hasRoot = true;
        segments.push(''); // This will produce a leading /
        segment = segment.replace(/^\/+/, '').replace(/\/+$/, '');
        if (segment) segments.push(segment);
        continue;
      }
    }

    // Remove leading/trailing slashes for middle/end segments
    segment = segment.replace(/^\/+/, '').replace(/\/+$/, '');
    if (segment) segments.push(segment);
  }

  let result = segments.join('/');

  // Ensure drive root ends with /
  result = result.replace(/^([A-Za-z]):$/, '$1:/');

  return result || '/';
}

// ============================================================================
// UNC Path Handling (Windows Network Paths)
// ============================================================================

/**
 * Check if a path is a UNC (Universal Naming Convention) path.
 * UNC paths start with \\ or // followed by server\share or server/share.
 */
export function isUNCPath(path: string): boolean {
  return /^(\\\\|\/\/)/.test(path);
}

/**
 * Check if a UNC path is at its root level (//server/share).
 */
export function isUNCRoot(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return /^\/\/[^/]+\/[^/]+\/?$/.test(normalized);
}

/**
 * Normalize a UNC path to use forward slashes.
 */
export function normalizeUNCPath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  // Ensure starts with //
  normalized = normalized.replace(/^\/+/, '//');
  // Remove trailing slash unless it's the share root
  if (!isUNCRoot(normalized)) {
    normalized = normalized.replace(/\/$/, '');
  }
  return normalized;
}

/**
 * Parse a UNC path into its components.
 * Returns null if not a valid UNC path.
 */
export function parseUNCPath(path: string): { server: string; share: string; path: string } | null {
  if (!isUNCPath(path)) return null;

  const normalized = normalizeUNCPath(path);
  const match = normalized.match(/^\/\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    server: match[1],
    share: match[2],
    path: match[3] || '/',
  };
}

// ============================================================================
// Path Comparison (Case-Sensitivity)
// ============================================================================

/**
 * Compare two paths for equality, respecting filesystem case sensitivity.
 * Windows/macOS: case-insensitive by default
 * Linux: case-sensitive
 *
 * @param pathA First path to compare
 * @param pathB Second path to compare
 * @param caseSensitive Force case-sensitive comparison (default: auto-detect)
 */
export function pathsEqual(pathA: string, pathB: string, caseSensitive?: boolean): boolean {
  const normA = normalizePathForCompare(pathA);
  const normB = normalizePathForCompare(pathB);

  // Default: Windows and macOS are case-insensitive
  const isCaseSensitive = caseSensitive ?? !(isWindows || isMacOS);

  if (isCaseSensitive) {
    return normA === normB;
  }
  return normA.toLowerCase() === normB.toLowerCase();
}

/**
 * Check if a path starts with another path (is child/descendant).
 * Respects filesystem case sensitivity.
 */
export function pathStartsWith(path: string, prefix: string, caseSensitive?: boolean): boolean {
  let normPath = normalizePathForCompare(path);
  let normPrefix = normalizePathForCompare(prefix);

  // Ensure prefix ends with / for proper directory matching
  if (!normPrefix.endsWith('/')) {
    normPrefix += '/';
  }
  if (!normPath.endsWith('/')) {
    normPath += '/';
  }

  const isCaseSensitive = caseSensitive ?? !(isWindows || isMacOS);

  if (isCaseSensitive) {
    return normPath.startsWith(normPrefix) || normPath.slice(0, -1) === normPrefix.slice(0, -1);
  }
  return (
    normPath.toLowerCase().startsWith(normPrefix.toLowerCase()) ||
    normPath.slice(0, -1).toLowerCase() === normPrefix.slice(0, -1).toLowerCase()
  );
}

/**
 * Check if a path is a child (direct or descendant) of another path.
 */
export function isChildPath(childPath: string, parentPath: string): boolean {
  const normChild = normalizePathForCompare(childPath);
  const normParent = normalizePathForCompare(parentPath);

  // Can't be child of itself
  if (pathsEqual(normChild, normParent)) return false;

  return pathStartsWith(normChild, normParent);
}

// ============================================================================
// System File Detection
// ============================================================================

/**
 * Check if a file should be hidden based on system file patterns.
 */
export function isSystemHiddenFile(filename: string): boolean {
  const name = basename(filename);

  for (const pattern of SYSTEM_HIDDEN_FILES) {
    if (pattern.endsWith('*')) {
      // Wildcard pattern (e.g., "._*")
      const prefix = pattern.slice(0, -1);
      if (name.startsWith(prefix)) return true;
    } else if (name === pattern) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a filename is .DS_Store (macOS metadata file).
 */
export function isDSStore(filename: string): boolean {
  return basename(filename) === '.DS_Store';
}

/**
 * Check if a filename is a macOS resource fork file (._prefix).
 */
export function isResourceFork(filename: string): boolean {
  return basename(filename).startsWith('._');
}

/**
 * Filter an array of filenames to remove system hidden files.
 */
export function filterSystemFiles<T>(
  files: T[],
  options: { showDSStore?: boolean; showResourceForks?: boolean } = {}
): T[] {
  return files.filter((file) => {
    let name: string | undefined;
    if (typeof file === 'string') {
      name = basename(file);
    } else if (file && typeof file === 'object') {
      const obj = file as Record<string, unknown>;
      if ('name' in obj && typeof obj.name === 'string') {
        name = obj.name;
      } else if ('path' in obj && typeof obj.path === 'string') {
        name = basename(obj.path);
      }
    }

    if (!name) return true; // Can't determine name, keep the file

    if (!options.showDSStore && isDSStore(name)) return false;
    if (!options.showResourceForks && isResourceFork(name)) return false;

    return true;
  });
}

// ============================================================================
// Windows Path Validation
// ============================================================================

/**
 * Check if a filename is a Windows reserved name.
 */
export function isWindowsReservedName(filename: string): boolean {
  const name = basename(filename);
  // Remove extension for comparison
  const nameWithoutExt = name.replace(/\.[^.]*$/, '').toUpperCase();
  return WINDOWS_RESERVED_NAMES.includes(nameWithoutExt);
}

/**
 * Check if a path is a Windows drive root (e.g., "C:/").
 */
export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:\/?$/.test(path);
}

/**
 * Check if a path is any root (Unix root, Windows drive, or UNC share).
 */
export function isRootPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/' || isDriveRoot(normalized) || isUNCRoot(normalized);
}

/**
 * Get the root of a path.
 */
export function getPathRoot(path: string): string {
  const normalized = normalizePath(path);

  // UNC path
  const uncParts = parseUNCPath(normalized);
  if (uncParts) {
    return `//${uncParts.server}/${uncParts.share}`;
  }

  // Windows drive
  const driveMatch = normalized.match(/^([A-Za-z]:)/);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}/`;
  }

  // Unix root
  return '/';
}

// ============================================================================
// Path Stack Building (for breadcrumbs)
// ============================================================================

/**
 * Build an array of path segments for breadcrumb navigation.
 * Returns array of { name, path } objects from root to the given path.
 */
export function buildPathStack(path: string): Array<{ name: string; path: string }> {
  const normalized = normalizePath(path);
  const result: Array<{ name: string; path: string }> = [];

  // Handle UNC path
  const uncParts = parseUNCPath(normalized);
  if (uncParts) {
    const root = `//${uncParts.server}/${uncParts.share}`;
    result.push({ name: `\\\\${uncParts.server}\\${uncParts.share}`, path: root });

    if (uncParts.path && uncParts.path !== '/') {
      const segments = uncParts.path.split('/').filter(Boolean);
      let currentPath = root;
      for (const segment of segments) {
        currentPath = `${currentPath}/${segment}`;
        result.push({ name: segment, path: currentPath });
      }
    }
    return result;
  }

  // Handle Windows drive path
  const driveMatch = normalized.match(/^([A-Za-z]):(\/.*)?$/);
  if (driveMatch) {
    const drive = `${driveMatch[1].toUpperCase()}:/`;
    result.push({ name: `${driveMatch[1].toUpperCase()}:`, path: drive });

    const rest = driveMatch[2];
    if (rest && rest !== '/') {
      const segments = rest.split('/').filter(Boolean);
      let currentPath = drive;
      for (const segment of segments) {
        currentPath = currentPath.endsWith('/')
          ? `${currentPath}${segment}`
          : `${currentPath}/${segment}`;
        result.push({ name: segment, path: currentPath });
      }
    }
    return result;
  }

  // Handle Unix path
  if (normalized.startsWith('/')) {
    result.push({ name: '/', path: '/' });
    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      result.push({ name: segment, path: currentPath });
    }
    return result;
  }

  // Relative path (shouldn't normally happen in file manager)
  const segments = normalized.split('/').filter(Boolean);
  let currentPath = '';
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    result.push({ name: segment, path: currentPath });
  }
  return result;
}

// ============================================================================
// Relative Path Computation
// ============================================================================

/**
 * Compute the relative path from one path to another.
 */
export function relativePath(from: string, to: string): string {
  const fromNorm = normalizePathForCompare(from);
  const toNorm = normalizePathForCompare(to);

  const fromParts = fromNorm.split('/').filter(Boolean);
  const toParts = toNorm.split('/').filter(Boolean);

  // Find common prefix length
  let commonLength = 0;
  const minLength = Math.min(fromParts.length, toParts.length);

  for (let i = 0; i < minLength; i++) {
    if (pathsEqual(fromParts[i], toParts[i])) {
      commonLength++;
    } else {
      break;
    }
  }

  // Build relative path
  const upCount = fromParts.length - commonLength;
  const downParts = toParts.slice(commonLength);

  const result = [...Array(upCount).fill('..'), ...downParts];

  return result.join('/') || '.';
}
