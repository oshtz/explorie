import type { FileEntry } from '../store';
import { basename } from './path';

export interface OperationItemDescriptor {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FailedOperationItem {
  name: string;
  error: string;
}

export function describeFileEntry(file: FileEntry): OperationItemDescriptor {
  return {
    path: file.path,
    name: file.name || basename(file.path) || file.path,
    isDir: file.is_dir,
  };
}

export function formatItemCount(count: number, singularName: string): string {
  return count === 1 ? singularName : `${count} items`;
}

export function summarizeFailedItems(failedItems: FailedOperationItem[], maxNames = 3): string {
  const names = failedItems
    .slice(0, maxNames)
    .map((item) => item.name)
    .join(', ');
  const moreCount =
    failedItems.length > maxNames ? ` and ${failedItems.length - maxNames} more` : '';
  return `${names}${moreCount}`;
}
