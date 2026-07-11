import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { IconName } from '../icons';
import type { DragOverlayState } from '../hooks/useFileDragAndDrop';
import type { DragPoint } from '../hooks/useDragStart';
import { prefersReducedMotion } from '../utils/accessibility';
import styles from '../App.module.css';
import { Icon } from './Icon';

type DragOverlayProps = {
  overlay: DragOverlayState | null;
  position: DragPoint;
  reduceMotion: boolean;
  onGatherComplete: () => void;
  onExitComplete: () => void;
};

type DragStyle = CSSProperties & Record<'--drag-x' | '--drag-y', string>;

const CHIP_WIDTH = 208;
const CHIP_HEIGHT = 44;
const STACK_OFFSETS = [
  { x: 10, y: 8, rotation: 0 },
  { x: 15, y: 13, rotation: -3 },
  { x: 5, y: 17, rotation: 3 },
  { x: 18, y: 20, rotation: -5 },
] as const;

function stackTransform(index: number, scale = 1): string {
  const offset = STACK_OFFSETS[index] ?? STACK_OFFSETS[STACK_OFFSETS.length - 1];
  return `translate3d(${offset.x}px, ${offset.y}px, 0) rotate(${offset.rotation}deg) scale(${scale})`;
}

function originTransform(origin: DragPoint, pointer: DragPoint, scale = 0.86): string {
  return `translate3d(${origin.x - pointer.x - CHIP_WIDTH / 2}px, ${origin.y - pointer.y - CHIP_HEIGHT / 2}px, 0) scale(${scale})`;
}

function waitForAnimations(animations: Animation[]): Promise<void> {
  return Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
    () => undefined
  );
}

export function DragOverlay({
  overlay,
  position,
  reduceMotion,
  onGatherComplete,
  onExitComplete,
}: DragOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const motionDisabled = reduceMotion || prefersReducedMotion();
  const phase = overlay?.phase;
  const items = overlay?.items;
  const pickupPoint = overlay?.pickupPoint;
  const releasePoint = overlay?.releasePoint;
  const destination = overlay?.destination;

  useLayoutEffect(() => {
    if (!phase || !items || !pickupPoint || phase === 'dragging') return;
    let cancelled = false;
    const animations: Animation[] = [];
    const finish = phase === 'gathering' ? onGatherComplete : onExitComplete;

    if (motionDisabled) {
      queueMicrotask(() => {
        if (!cancelled) finish();
      });
      return () => {
        cancelled = true;
      };
    }

    if (phase === 'gathering') {
      items.forEach((item, index) => {
        const element = itemRefs.current[index];
        if (!element?.animate) return;
        animations.push(
          element.animate(
            [
              {
                transform: originTransform(item.origin, pickupPoint),
                opacity: 0.35,
                filter: 'blur(1px)',
              },
              {
                transform: stackTransform(index),
                opacity: 1,
                filter: 'blur(0)',
              },
            ],
            {
              duration: 160,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              fill: 'both',
            }
          )
        );
      });
    } else if (phase === 'dropping') {
      const release = releasePoint ?? pickupPoint;
      if (destination && rootRef.current?.animate) {
        animations.push(
          rootRef.current.animate(
            [
              { transform: `translate3d(${release.x}px, ${release.y}px, 0)` },
              {
                transform: `translate3d(${destination.x - CHIP_WIDTH / 2}px, ${destination.y - CHIP_HEIGHT / 2}px, 0)`,
              },
            ],
            {
              duration: 140,
              easing: 'cubic-bezier(0.32, 0, 0.67, 0)',
              fill: 'both',
            }
          )
        );
      }
      items.forEach((_, index) => {
        const element = itemRefs.current[index];
        if (!element?.animate) return;
        animations.push(
          element.animate(
            [
              { transform: stackTransform(index), opacity: 1 },
              { transform: stackTransform(index, 0.68), opacity: 0 },
            ],
            { duration: 140, easing: 'cubic-bezier(0.32, 0, 0.67, 0)', fill: 'both' }
          )
        );
      });
    } else {
      const release = releasePoint ?? pickupPoint;
      items.forEach((item, index) => {
        const element = itemRefs.current[index];
        if (!element?.animate) return;
        animations.push(
          element.animate(
            [
              { transform: stackTransform(index), opacity: 1 },
              { transform: originTransform(item.origin, release, 0.92), opacity: 0.25 },
            ],
            {
              duration: 220,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              fill: 'both',
            }
          )
        );
      });
    }

    const completion = animations.length > 0 ? waitForAnimations(animations) : Promise.resolve();
    void completion.then(() => {
      if (!cancelled) finish();
    });

    return () => {
      cancelled = true;
      animations.forEach((animation) => animation.cancel());
    };
  }, [
    onExitComplete,
    onGatherComplete,
    destination,
    items,
    phase,
    pickupPoint,
    releasePoint,
    motionDisabled,
  ]);

  if (!overlay) return null;
  const overlayStyle: DragStyle = {
    '--drag-x': `${position.x}px`,
    '--drag-y': `${position.y}px`,
  };

  return (
    <div
      ref={rootRef}
      className={styles.dragOverlay}
      style={overlayStyle}
      data-phase={overlay.phase}
      data-operation={overlay.operation}
      data-testid="drag-overlay"
      aria-hidden="true"
    >
      {overlay.items.map((item, index) => (
        <div
          key={item.id}
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          className={styles.dragChip}
          style={{
            transform: stackTransform(index),
            zIndex: overlay.items.length - index,
          }}
          data-testid="drag-chip"
        >
          <span className={styles.dragChipIcon}>
            <Icon name={item.icon as IconName} />
          </span>
          <span className={styles.dragChipLabel}>{item.label}</span>
          {index === 0 && overlay.totalCount > 1 && (
            <span className={styles.dragCount}>{overlay.totalCount}</span>
          )}
          {index === 0 && <span className={styles.dragOperation}>{overlay.operation}</span>}
        </div>
      ))}
    </div>
  );
}
