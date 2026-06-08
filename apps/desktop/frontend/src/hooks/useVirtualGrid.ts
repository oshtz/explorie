import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualGridOptions {
  /** Total number of items */
  count: number;
  /** Reference to the scrollable container */
  parentRef: React.RefObject<HTMLElement>;
  /** Width of each grid item in pixels */
  itemWidth: number;
  /** Height of each grid item in pixels */
  itemHeight: number;
  /** Gap between items in pixels */
  gap?: number;
  /** Number of extra rows to render outside viewport */
  overscan?: number;
  /** Freeze virtualization (useful during drag) */
  freeze?: boolean;
}

export interface VirtualGridResult {
  /** Total height of the virtualized content */
  totalHeight: number;
  /** Number of columns based on container width */
  columnCount: number;
  /** Virtual rows to render */
  virtualRows: Array<{
    index: number;
    start: number;
    size: number;
    key: React.Key;
  }>;
  /** Get items for a specific row */
  getRowItems: (rowIndex: number) => number[];
}

/**
 * Hook for virtualizing a grid layout.
 * Calculates rows based on container width and virtualizes row rendering.
 */
export function useVirtualGrid(options: VirtualGridOptions): VirtualGridResult {
  const {
    count,
    parentRef,
    itemWidth,
    itemHeight,
    gap = 12,
    overscan = 2,
    freeze = false,
  } = options;

  // Track container width to calculate columns
  const [containerWidth, setContainerWidth] = React.useState(0);

  React.useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const updateWidth = () => {
      const width = el.clientWidth;
      if (width !== containerWidth) {
        setContainerWidth(width);
      }
    };

    // Initial measurement
    updateWidth();

    // Watch for resize
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);

    return () => observer.disconnect();
  }, [parentRef, containerWidth]);

  // Calculate number of columns that fit
  const columnCount = React.useMemo(() => {
    if (containerWidth === 0) return 1;
    // Account for padding and gaps
    const availableWidth = containerWidth - gap; // subtract one gap for padding
    const cols = Math.floor((availableWidth + gap) / (itemWidth + gap));
    return Math.max(1, cols);
  }, [containerWidth, itemWidth, gap]);

  // Calculate number of rows
  const rowCount = Math.ceil(count / columnCount);

  // Virtualize rows
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight + gap,
    overscan,
  });

  // Cache last result for freeze mode
  const lastRef = React.useRef<VirtualGridResult>({
    totalHeight: 0,
    columnCount: 1,
    virtualRows: [],
    getRowItems: () => [],
  });

  const getRowItems = React.useCallback(
    (rowIndex: number): number[] => {
      const startIndex = rowIndex * columnCount;
      const items: number[] = [];
      for (let i = 0; i < columnCount && startIndex + i < count; i++) {
        items.push(startIndex + i);
      }
      return items;
    },
    [columnCount, count]
  );

  const compute = (): VirtualGridResult => {
    const virtualItems = rowVirtualizer.getVirtualItems();
    return {
      totalHeight: rowVirtualizer.getTotalSize(),
      columnCount,
      virtualRows: virtualItems.map((item) => ({
        index: item.index,
        start: item.start,
        size: item.size,
        key: item.key,
      })),
      getRowItems,
    };
  };

  const current = compute();

  if (!freeze || lastRef.current.virtualRows.length === 0) {
    lastRef.current = current;
  }

  return freeze ? lastRef.current : current;
}
