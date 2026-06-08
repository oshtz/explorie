import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarqueeSelection } from './useMarqueeSelection';

describe('useMarqueeSelection', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.style.width = '200px';
    container.style.height = '200px';
    document.body.appendChild(container);
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('selects intersecting items after drag threshold', () => {
    const onSelectionChange = vi.fn();
    const containerRef = { current: container };

    const getItemRect = (index: number) => {
      const rects = [
        { left: 0, top: 0, right: 50, bottom: 50 },
        { left: 60, top: 0, right: 110, bottom: 50 },
        { left: 0, top: 60, right: 50, bottom: 110 },
      ];
      return rects[index] ?? null;
    };

    const getItemId = (index: number) => ['a', 'b', 'c'][index] ?? '';

    const { result } = renderHook(() =>
      useMarqueeSelection({
        containerRef,
        getItemRect,
        itemCount: 3,
        getItemId,
        onSelectionChange,
      })
    );

    const mouseDownEvent = {
      button: 0,
      clientX: 10,
      clientY: 10,
      target: container,
      ctrlKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.onMouseDown(mouseDownEvent);
    });

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 40 }));
    window.dispatchEvent(new MouseEvent('mouseup'));

    const lastCall = onSelectionChange.mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    const selected = Array.from(lastCall![0] as Set<string>).sort();
    expect(selected).toEqual(['a', 'b']);
  });

  it('fires onEmptyClick when no drag occurs', () => {
    const onSelectionChange = vi.fn();
    const onEmptyClick = vi.fn();
    const containerRef = { current: container };

    const { result } = renderHook(() =>
      useMarqueeSelection({
        containerRef,
        getItemRect: () => null,
        itemCount: 0,
        getItemId: () => '',
        onSelectionChange,
        onEmptyClick,
      })
    );

    const mouseDownEvent = {
      button: 0,
      clientX: 10,
      clientY: 10,
      target: container,
      ctrlKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.onMouseDown(mouseDownEvent);
    });

    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(onEmptyClick).toHaveBeenCalledTimes(1);
  });
});
