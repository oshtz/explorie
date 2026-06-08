/**
 * Minimal SDK surface for explorie clients.
 * This intentionally stays framework-agnostic so it can be consumed by CLI/desktop/web layers.
 */

export type CustomFields = Record<string, unknown>;

export type FileEntry = {
  id: string;
  path: string;
  name?: string;
  size: number;
  modified: string | number | Date;
  hidden?: boolean;
  is_dir: boolean;
  custom: CustomFields;
};

export type MetadataIndex = Record<string, CustomFields>;

/**
 * Parse an .explorie.json metadata file. Returns an empty object on failure.
 */
export function parseMetadata(jsonText: string): MetadataIndex {
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MetadataIndex;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Merge user-provided custom fields into a metadata index.
 */
export function mergeMetadata(
  base: MetadataIndex,
  fileName: string,
  custom: CustomFields
): MetadataIndex {
  const next: MetadataIndex = { ...base };
  next[fileName] = { ...(base[fileName] || {}), ...custom };
  return next;
}

/**
 * Simple human-readable byte formatter to mirror the CLI output.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${value} ${units[idx]}` : `${value.toFixed(1)} ${units[idx]}`;
}
