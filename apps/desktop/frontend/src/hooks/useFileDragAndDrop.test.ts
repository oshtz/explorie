import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useFileDragAndDrop } from './useFileDragAndDrop';

const mocks = vi.hoisted(() => ({
  moveToFolder: vi.fn(),
}));

const originalVisibilityState = document.visibilityState;

vi.mock('../utils/fs', () => ({
  moveToFolder: mocks.moveToFolder,
}));

function file(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: name,
    path: `/source/${name}`,
    name,
    size: 128,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function renderDnd(overrides: Partial<Parameters<typeof useFileDragAndDrop>[0]> = {}) {
  const files = [
    file('photo.png'),
    file('docs', { path: '/target/docs', is_dir: true }),
    file('song.mp3'),
  ];
  const props = {
    files,
    columnFiles: {
      '/source': files,
    },
    viewMode: 'list' as const,
    refreshVisibleViews: vi.fn(async () => {}),
    getParentPath: vi.fn((path: string) => path.split('/').slice(0, -1).join('/') || '/'),
    ...overrides,
  };

  return {
    props,
    ...renderHook(() => useFileDragAndDrop(props)),
  };
}

describe('useFileDragAndDrop', () => {
  beforeEach(() => {
    mocks.moveToFolder.mockReset();
    mocks.moveToFolder.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibilityState,
    });
  });

  it('begins drags with file-type overlays, tracks hover state, and mouse position', () => {
    const { result } = renderDnd();

    act(() => {
      result.current.beginDrag(file('photo.png'));
    });

    expect(result.current.draggingId).toBe('file:photo.png');
    expect(result.current.dragOverlay).toEqual({ label: 'photo.png', icon: 'image' });

    act(() => {
      result.current.handleHoverFolder(file('docs', { is_dir: true }));
      result.current.handleHoverContainerPath('/target');
    });

    expect(result.current.combineTargetId).toBe('docs');

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 30 }));
    });

    expect(result.current.dragPos).toEqual({ x: 28, y: 38 });
  });

  it('moves dragged files into hovered directories and resets drag state', async () => {
    const { result, props } = renderDnd();

    act(() => {
      result.current.beginDrag(props.files[0]);
      result.current.handleHoverFolder(props.files[1]);
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    await waitFor(() =>
      expect(mocks.moveToFolder).toHaveBeenCalledWith('/source/photo.png', '/target/docs')
    );
    await waitFor(() => expect(props.refreshVisibleViews).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(result.current.draggingId).toBeNull());
    expect(result.current.dragOverlay).toBeNull();
    expect(result.current.dndEpoch).toBe(1);
  });

  it('moves to hovered container paths and skips moves to the same parent', async () => {
    const { result, props, rerender } = renderDnd();

    act(() => {
      result.current.beginDrag(props.files[2]);
    });

    act(() => {
      result.current.handleHoverContainerPath('/music');
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });

    await waitFor(() =>
      expect(mocks.moveToFolder).toHaveBeenCalledWith('/source/song.mp3', '/music')
    );

    mocks.moveToFolder.mockClear();

    act(() => {
      rerender();
      result.current.beginDrag(props.files[2]);
    });

    act(() => {
      result.current.handleHoverContainerPath('/source');
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('blur'));
    });

    await waitFor(() => expect(props.refreshVisibleViews).toHaveBeenCalledTimes(2));
    expect(mocks.moveToFolder).not.toHaveBeenCalled();
  });

  it('finds column-mode files, refreshes on move errors, and handles hidden-tab cleanup', async () => {
    const refreshVisibleViews = vi.fn(async () => {});
    mocks.moveToFolder.mockRejectedValueOnce(new Error('move failed'));
    const columnFile = file('clip.mp4', { path: '/columns/clip.mp4' });
    const target = file('videos', { path: '/videos', is_dir: true });
    const { result } = renderDnd({
      files: [],
      columnFiles: {
        '/columns': [columnFile, target],
      },
      viewMode: 'column',
      refreshVisibleViews,
    });

    act(() => {
      result.current.beginDrag(columnFile);
      result.current.handleHoverFolder(target);
    });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() =>
      expect(mocks.moveToFolder).toHaveBeenCalledWith('/columns/clip.mp4', '/videos')
    );
    await waitFor(() => expect(refreshVisibleViews).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.draggingId).toBeNull());
  });
});
