import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/react-virtual';

// Thin abstraction over @tanstack/react-virtual to keep usage centralized.
export type VirtualRow = { index: number; start: number; size: number; key: React.Key };

export function useVirtualRows(options: {
  count: number;
  parentRef: React.RefObject<HTMLElement>;
  estimateSize?: number;
  overscan?: number;
  freeze?: boolean;
}): { totalSize: number; virtualRows: VirtualRow[] } {
  const { count, parentRef, estimateSize = 34, overscan = 3, freeze = false } = options;

  const api = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  });

  const lastRef = React.useRef<{ totalSize: number; virtualRows: VirtualRow[] }>({
    totalSize: 0,
    virtualRows: [],
  });
  const compute = () => {
    const virtualItems = api.getVirtualItems();
    return {
      totalSize: api.getTotalSize(),
      virtualRows: virtualItems.map((it: VirtualItem) => ({
        index: it.index,
        start: it.start,
        size: it.size,
        key: it.key,
      })),
    };
  };
  const current = compute();
  if (!freeze || lastRef.current.virtualRows.length === 0) {
    lastRef.current = current;
  }
  return freeze ? lastRef.current : current;
}
