import type { FileEntry } from '../store';
import { isColumnCandidate } from './customFieldTypes';

/**
 * Returns a sorted list of custom column keys present in the dataset.
 * Scans up to `MAX_SCAN` entries to keep cost bounded on huge folders.
 */
export function getCustomColumns(files: FileEntry[]): string[] {
  const MAX_SCAN = 500; // cap work for very large lists
  const set = new Set<string>();
  for (let i = 0; i < files.length && i < MAX_SCAN; i++) {
    const f = files[i];
    const custom = f?.custom || {};
    for (const k of Object.keys(custom)) {
      const v = custom[k];
      if (isColumnCandidate(k, v)) set.add(k);
    }
  }
  return Array.from(set).sort();
}
