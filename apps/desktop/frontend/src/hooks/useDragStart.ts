import * as React from 'react';
import type { FileEntry } from '../store';

interface UseDragStartOptions {
  onBeginDrag?: (file: FileEntry) => void;
  threshold?: number; // pixels before starting drag
  isEnabled?: boolean; // allow opt-out while already dragging
}

export function useDragStart({
  onBeginDrag,
  threshold = 5,
  isEnabled = true,
}: UseDragStartOptions) {
  const pendingRef = React.useRef<{
    file: FileEntry | null;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);

  React.useEffect(() => {
    return () => {
      pendingRef.current = null;
    };
  }, []);

  const onMouseDown = React.useCallback(
    (e: React.MouseEvent, file: FileEntry) => {
      if (!isEnabled) return;
      if (e.button !== 0) return; // left button only
      // Do not prevent default here; allow click/selection to work.
      pendingRef.current = { file, startX: e.clientX, startY: e.clientY, started: false };

      const handleMove = (ev: MouseEvent) => {
        const p = pendingRef.current;
        if (!p || p.started === true) return;
        const dx = Math.abs(ev.clientX - p.startX);
        const dy = Math.abs(ev.clientY - p.startY);
        if (dx >= threshold || dy >= threshold) {
          p.started = true;
          if (p.file && onBeginDrag) onBeginDrag(p.file);
        }
      };
      const cleanup = () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', cleanup);
        pendingRef.current = null;
      };
      window.addEventListener('mousemove', handleMove, { passive: true });
      window.addEventListener('mouseup', cleanup);
    },
    [isEnabled, onBeginDrag, threshold]
  );

  return { onMouseDown };
}
