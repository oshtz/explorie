import * as React from 'react';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UseMarqueeSelectionOptions {
  /** Reference to the scrollable container */
  containerRef: React.RefObject<HTMLElement>;
  /** Get the bounding rect of an item by index (relative to scroll content, not viewport) */
  getItemRect: (index: number) => Rect | null;
  /** Total number of items */
  itemCount: number;
  /** Get the ID of an item by index */
  getItemId: (index: number) => string;
  /** Called when selection changes during marquee drag */
  onSelectionChange: (ids: Set<string>, additive: boolean) => void;
  /** Whether marquee selection is enabled */
  enabled?: boolean;
  /** Pixels to move before marquee activates (default: 5) */
  threshold?: number;
  /** CSS selector for items that should block marquee start */
  itemSelector?: string;
  /** Vertical offset for content (e.g., table header height) */
  contentOffsetTop?: number;
  /** Called when user clicks on empty space without dragging (for clearing selection) */
  onEmptyClick?: () => void;
}

export interface UseMarqueeSelectionResult {
  /** Whether marquee is currently active */
  isActive: boolean;
  /** Current marquee rectangle (for rendering), relative to scroll content */
  rect: MarqueeRect | null;
  /** Handler to attach to container's onMouseDown */
  onMouseDown: (e: React.MouseEvent) => void;
}

/**
 * Hook for marquee (rubber-band) selection like in Windows Explorer or macOS Finder.
 * Click and drag on empty space to select items within the rectangle.
 */
export function useMarqueeSelection(
  options: UseMarqueeSelectionOptions
): UseMarqueeSelectionResult {
  const {
    containerRef,
    getItemRect,
    itemCount,
    getItemId,
    onSelectionChange,
    enabled = true,
    threshold = 5,
    itemSelector = '.gridItem, tr.clickable',
    contentOffsetTop = 0,
    onEmptyClick,
  } = options;

  const [isActive, setIsActive] = React.useState(false);
  const [rect, setRect] = React.useState<MarqueeRect | null>(null);

  // Track state during drag
  const stateRef = React.useRef<{
    startX: number;
    startY: number;
    startScrollTop: number;
    startScrollLeft: number;
    isAdditive: boolean;
    activated: boolean;
  } | null>(null);

  // Auto-scroll interval
  const scrollIntervalRef = React.useRef<number | null>(null);

  const clearScrollInterval = React.useCallback(() => {
    if (scrollIntervalRef.current !== null) {
      window.clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Calculate which items intersect with the marquee
  const getIntersectingItems = React.useCallback(
    (marqueeRect: Rect): Set<string> => {
      const selected = new Set<string>();
      for (let i = 0; i < itemCount; i++) {
        const itemRect = getItemRect(i);
        if (itemRect) {
          // Apply content offset to item positions
          const offsetRect = {
            left: itemRect.left,
            top: itemRect.top + contentOffsetTop,
            right: itemRect.right,
            bottom: itemRect.bottom + contentOffsetTop,
          };
          if (rectsIntersect(marqueeRect, offsetRect)) {
            selected.add(getItemId(i));
          }
        }
      }
      return selected;
    },
    [itemCount, getItemRect, getItemId, contentOffsetTop]
  );

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      if (e.button !== 0) return; // Left button only

      const container = containerRef.current;
      if (!container) return;

      // Don't start marquee if clicking on an item
      const target = e.target as HTMLElement;
      if (target.closest(itemSelector)) return;
      if (target.closest('thead')) return; // Ignore table header

      const containerRect = container.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      const scrollLeft = container.scrollLeft;

      // Position relative to scroll content (not viewport)
      const startX = e.clientX - containerRect.left + scrollLeft;
      const startY = e.clientY - containerRect.top + scrollTop;

      stateRef.current = {
        startX,
        startY,
        startScrollTop: scrollTop,
        startScrollLeft: scrollLeft,
        isAdditive: e.ctrlKey || e.metaKey,
        activated: false,
      };

      const handleMouseMove = (ev: MouseEvent) => {
        const state = stateRef.current;
        if (!state) return;

        const currentScrollTop = container.scrollTop;
        const currentScrollLeft = container.scrollLeft;
        const currentX = ev.clientX - containerRect.left + currentScrollLeft;
        const currentY = ev.clientY - containerRect.top + currentScrollTop;

        // Check threshold
        if (!state.activated) {
          const dx = Math.abs(currentX - state.startX);
          const dy = Math.abs(currentY - state.startY);
          if (dx < threshold && dy < threshold) return;
          state.activated = true;
          setIsActive(true);
        }

        // Calculate marquee rectangle
        const left = Math.min(state.startX, currentX);
        const top = Math.min(state.startY, currentY);
        const right = Math.max(state.startX, currentX);
        const bottom = Math.max(state.startY, currentY);

        setRect({
          left,
          top,
          width: right - left,
          height: bottom - top,
        });

        // Find intersecting items
        const marqueeRect: Rect = { left, top, right, bottom };
        const intersecting = getIntersectingItems(marqueeRect);
        onSelectionChange(intersecting, state.isAdditive);

        // Auto-scroll when near edges
        const edgeThreshold = 40;
        const scrollSpeed = 10;
        const viewportY = ev.clientY - containerRect.top;
        const viewportX = ev.clientX - containerRect.left;

        clearScrollInterval();

        let scrollDeltaY = 0;
        let scrollDeltaX = 0;

        if (viewportY < edgeThreshold) {
          scrollDeltaY = -scrollSpeed;
        } else if (viewportY > containerRect.height - edgeThreshold) {
          scrollDeltaY = scrollSpeed;
        }

        if (viewportX < edgeThreshold) {
          scrollDeltaX = -scrollSpeed;
        } else if (viewportX > containerRect.width - edgeThreshold) {
          scrollDeltaX = scrollSpeed;
        }

        if (scrollDeltaX !== 0 || scrollDeltaY !== 0) {
          scrollIntervalRef.current = window.setInterval(() => {
            container.scrollTop += scrollDeltaY;
            container.scrollLeft += scrollDeltaX;
          }, 16);
        }
      };

      const handleMouseUp = () => {
        clearScrollInterval();
        const wasActivated = stateRef.current?.activated ?? false;
        stateRef.current = null;
        setIsActive(false);
        setRect(null);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        // If marquee never activated (just a click), trigger empty click handler
        if (!wasActivated && onEmptyClick) {
          onEmptyClick();
        }
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);

      // Prevent text selection during drag
      e.preventDefault();
    },
    [
      enabled,
      containerRef,
      itemSelector,
      threshold,
      getIntersectingItems,
      onSelectionChange,
      clearScrollInterval,
      onEmptyClick,
    ]
  );

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      clearScrollInterval();
    };
  }, [clearScrollInterval]);

  return {
    isActive,
    rect,
    onMouseDown: handleMouseDown,
  };
}

/**
 * Check if two rectangles intersect (AABB collision)
 */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}
