import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useDragStart } from './useDragStart';

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'file-1',
    path: '/workspace/report.txt',
    name: 'report.txt',
    size: 128,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function mouseDownEvent(overrides: Partial<React.MouseEvent> = {}) {
  return {
    button: 0,
    clientX: 10,
    clientY: 10,
    ...overrides,
  } as React.MouseEvent;
}

describe('useDragStart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts dragging once pointer movement reaches the threshold', () => {
    const onBeginDrag = vi.fn();
    const draggedFile = file();
    const { result } = renderHook(() => useDragStart({ onBeginDrag, threshold: 8 }));

    act(() => {
      result.current.onMouseDown(mouseDownEvent(), draggedFile);
    });

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 14, clientY: 14 }));
    expect(onBeginDrag).not.toHaveBeenCalled();

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 19, clientY: 14 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 30 }));

    expect(onBeginDrag).toHaveBeenCalledTimes(1);
    expect(onBeginDrag).toHaveBeenCalledWith(draggedFile);
  });

  it('ignores disabled, non-left-button, and mouseup-before-threshold starts', () => {
    const disabledBeginDrag = vi.fn();
    const disabled = renderHook(() =>
      useDragStart({ onBeginDrag: disabledBeginDrag, isEnabled: false })
    );

    act(() => {
      disabled.result.current.onMouseDown(mouseDownEvent(), file());
    });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
    expect(disabledBeginDrag).not.toHaveBeenCalled();
    disabled.unmount();

    const onBeginDrag = vi.fn();
    const { result } = renderHook(() => useDragStart({ onBeginDrag }));

    act(() => {
      result.current.onMouseDown(mouseDownEvent({ button: 2 }), file());
    });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
    expect(onBeginDrag).not.toHaveBeenCalled();

    act(() => {
      result.current.onMouseDown(mouseDownEvent(), file());
    });
    window.dispatchEvent(new MouseEvent('mouseup'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));

    expect(onBeginDrag).not.toHaveBeenCalled();
  });

  it('clears pending drag state on unmount', () => {
    const onBeginDrag = vi.fn();
    const { result, unmount } = renderHook(() => useDragStart({ onBeginDrag }));

    act(() => {
      result.current.onMouseDown(mouseDownEvent(), file());
    });

    unmount();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));

    expect(onBeginDrag).not.toHaveBeenCalled();
  });
});
