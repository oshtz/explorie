import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculatePaneLayout, useAppLayoutPersistence } from './useAppLayoutPersistence';

function mouseEvent(clientX: number) {
  return {
    preventDefault: vi.fn(),
    clientX,
  } as unknown as React.MouseEvent;
}

describe('useAppLayoutPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.className = '';
  });

  it('loads clamped persisted widths and persists changes', () => {
    localStorage.setItem('explorie:sidebarWidth', '9999');
    localStorage.setItem('explorie:previewWidth', '10');

    const { result } = renderHook(() => useAppLayoutPersistence('resizing'));

    expect(result.current.sidebarWidth).toBe(480);
    expect(result.current.previewWidth).toBe(280);

    act(() => {
      result.current.setSidebarWidth(200);
      result.current.setPreviewWidth(400);
    });

    expect(localStorage.getItem('explorie:sidebarWidth')).toBe('200');
    expect(localStorage.getItem('explorie:previewWidth')).toBe('400');
  });

  it('resizes sidebar and preview with mouse movement', () => {
    const { result } = renderHook(() => useAppLayoutPersistence('resizing'));

    act(() => {
      result.current.handleSidebarResizeStart(mouseEvent(100));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150 }));
    });
    expect(result.current.sidebarWidth).toBe(270);

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(document.body.classList.contains('resizing')).toBe(false);

    act(() => {
      result.current.handlePreviewResizeStart(mouseEvent(500));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 450 }));
    });
    expect(result.current.previewWidth).toBe(410);
  });

  it('preserves preferred panes while protecting the file surface', () => {
    expect(calculatePaneLayout(800, 480, 360, true)).toEqual({
      sidebarWidth: 372,
      previewWidth: 360,
      previewVisible: false,
    });
    expect(calculatePaneLayout(1024, 220, 360, true)).toEqual({
      sidebarWidth: 220,
      previewWidth: 360,
      previewVisible: true,
    });
    expect(calculatePaneLayout(1440, 480, 720, true)).toEqual({
      sidebarWidth: 480,
      previewWidth: 524,
      previewVisible: true,
    });
  });
});
