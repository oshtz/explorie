import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragOverlayState } from '../hooks/useFileDragAndDrop';
import { DragOverlay } from './DragOverlay';

function overlay(overrides: Partial<DragOverlayState> = {}): DragOverlayState {
  return {
    items: Array.from({ length: 4 }, (_, index) => ({
      id: `file-${index}`,
      label: `File ${index}`,
      icon: 'file',
      origin: { x: index * 20, y: index * 10 },
    })),
    totalCount: 6,
    pickupPoint: { x: 100, y: 120 },
    releasePoint: null,
    phase: 'gathering',
    destination: null,
    operation: 'move',
    ...overrides,
  };
}

describe('DragOverlay', () => {
  const animate = vi.fn();

  beforeEach(() => {
    animate.mockImplementation(() => ({
      finished: Promise.resolve(),
      cancel: vi.fn(),
    }));
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders at most four gathered chips with the full selection count', async () => {
    const onGatherComplete = vi.fn();
    render(
      <DragOverlay
        overlay={overlay()}
        position={{ x: 130, y: 140 }}
        reduceMotion={false}
        onGatherComplete={onGatherComplete}
        onExitComplete={vi.fn()}
      />
    );

    expect(screen.getAllByTestId('drag-chip')).toHaveLength(4);
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByTestId('drag-overlay')).toHaveAttribute('data-phase', 'gathering');
    await waitFor(() => expect(onGatherComplete).toHaveBeenCalledTimes(1));
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it('collapses into a visible destination and completes independently', async () => {
    const onExitComplete = vi.fn();
    render(
      <DragOverlay
        overlay={overlay({
          phase: 'dropping',
          releasePoint: { x: 200, y: 220 },
          destination: { x: 500, y: 300 },
        })}
        position={{ x: 200, y: 220 }}
        reduceMotion={false}
        onGatherComplete={vi.fn()}
        onExitComplete={onExitComplete}
      />
    );

    await waitFor(() => expect(onExitComplete).toHaveBeenCalledTimes(1));
    expect(animate).toHaveBeenCalledTimes(5);
  });

  it('skips animations when reduced motion is enabled', async () => {
    const onExitComplete = vi.fn();
    render(
      <DragOverlay
        overlay={overlay({ phase: 'returning', releasePoint: { x: 50, y: 60 } })}
        position={{ x: 50, y: 60 }}
        reduceMotion
        onGatherComplete={vi.fn()}
        onExitComplete={onExitComplete}
      />
    );

    await waitFor(() => expect(onExitComplete).toHaveBeenCalledTimes(1));
    expect(animate).not.toHaveBeenCalled();
  });

  it('also respects the system reduced-motion preference', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList
    );
    const onExitComplete = vi.fn();
    render(
      <DragOverlay
        overlay={overlay({ phase: 'returning', releasePoint: { x: 50, y: 60 } })}
        position={{ x: 50, y: 60 }}
        reduceMotion={false}
        onGatherComplete={vi.fn()}
        onExitComplete={onExitComplete}
      />
    );

    await waitFor(() => expect(onExitComplete).toHaveBeenCalledTimes(1));
    expect(animate).not.toHaveBeenCalled();
  });
});
