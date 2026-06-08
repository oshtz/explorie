import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualGrid } from './useVirtualGrid';

const mocks = vi.hoisted(() => ({
  virtualItems: [
    { index: 0, start: 0, size: 110, key: 'row-0' },
    { index: 1, start: 110, size: 110, key: 'row-1' },
  ],
  totalSize: 220,
  useVirtualizer: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: mocks.useVirtualizer,
}));

class MockResizeObserver {
  static callbacks: ResizeObserverCallback[] = [];

  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.callbacks.push(callback);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function createParent(width: number) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  return { current: element } as React.RefObject<HTMLElement>;
}

describe('useVirtualGrid', () => {
  beforeEach(() => {
    MockResizeObserver.callbacks = [];
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: MockResizeObserver,
    });
    mocks.useVirtualizer.mockReset();
    mocks.useVirtualizer.mockReturnValue({
      getVirtualItems: () => mocks.virtualItems,
      getTotalSize: () => mocks.totalSize,
    });
  });

  it('calculates columns, virtual rows, and row item indexes', () => {
    const parentRef = createParent(360);

    const { result } = renderHook(() =>
      useVirtualGrid({
        count: 8,
        parentRef,
        itemWidth: 100,
        itemHeight: 90,
        gap: 10,
        overscan: 3,
      })
    );

    expect(result.current.columnCount).toBe(3);
    expect(result.current.totalHeight).toBe(220);
    expect(result.current.virtualRows).toEqual([
      { index: 0, start: 0, size: 110, key: 'row-0' },
      { index: 1, start: 110, size: 110, key: 'row-1' },
    ]);
    expect(result.current.getRowItems(0)).toEqual([0, 1, 2]);
    expect(result.current.getRowItems(2)).toEqual([6, 7]);
    expect(mocks.useVirtualizer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        count: 3,
        overscan: 3,
      })
    );
  });

  it('uses one column before measurement and disconnects resize observer', () => {
    const parentRef = { current: null } as unknown as React.RefObject<HTMLElement>;

    const { result, unmount } = renderHook(() =>
      useVirtualGrid({
        count: 3,
        parentRef,
        itemWidth: 100,
        itemHeight: 100,
      })
    );

    expect(result.current.columnCount).toBe(1);
    expect(result.current.getRowItems(2)).toEqual([2]);

    unmount();
  });

  it('returns the last computed result while frozen', () => {
    const parentRef = createParent(360);
    const { result, rerender } = renderHook(
      ({ freeze }) =>
        useVirtualGrid({
          count: 8,
          parentRef,
          itemWidth: 100,
          itemHeight: 90,
          gap: 10,
          freeze,
        }),
      {
        initialProps: { freeze: false },
      }
    );

    const unfrozenRows = result.current.virtualRows;
    mocks.virtualItems = [{ index: 2, start: 220, size: 110, key: 'row-2' }];
    mocks.totalSize = 330;

    act(() => {
      rerender({ freeze: true });
    });

    expect(result.current.virtualRows).toBe(unfrozenRows);
    expect(result.current.totalHeight).toBe(220);
  });
});
