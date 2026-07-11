import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { isValidDropTarget, useFileDragAndDrop } from './useFileDragAndDrop';

const mocks = vi.hoisted(() => ({
  moveWithUndoAndConflictResolution: vi.fn(),
  copyWithUndoAndConflictResolution: vi.fn(),
}));

const originalVisibilityState = document.visibilityState;

vi.mock('../utils/fileOperations', () => ({
  moveWithUndoAndConflictResolution: mocks.moveWithUndoAndConflictResolution,
  copyWithUndoAndConflictResolution: mocks.copyWithUndoAndConflictResolution,
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
    file('elsewhere.txt', { path: '/other/elsewhere.txt' }),
  ];
  const props = {
    files,
    columnFiles: { '/source': files },
    viewMode: 'list' as const,
    selectedPaths: [] as string[],
    setSelectedPaths: vi.fn(),
    refreshVisibleViews: vi.fn(async () => {}),
    getParentPath: vi.fn((path: string) => path.split('/').slice(0, -1).join('/') || '/'),
    showToast: vi.fn(),
    addFavorite: vi.fn(),
    onOpenFolder: vi.fn(),
    ...overrides,
  };

  return { props, ...renderHook(() => useFileDragAndDrop(props)) };
}

describe('useFileDragAndDrop', () => {
  beforeEach(() => {
    mocks.moveWithUndoAndConflictResolution.mockReset();
    mocks.moveWithUndoAndConflictResolution.mockResolvedValue(true);
    mocks.copyWithUndoAndConflictResolution.mockReset();
    mocks.copyWithUndoAndConflictResolution.mockResolvedValue(true);
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibilityState,
    });
  });

  it('gathers the full selection across folders and tracks the pointer', () => {
    const { result, props } = renderDnd({
      selectedPaths: ['/source/photo.png', '/source/song.mp3', '/other/elsewhere.txt'],
    });
    act(() => {
      result.current.beginDrag(props.files[0], { x: 12, y: 18 });
    });

    expect([...result.current.draggingItemIds]).toEqual(['photo.png', 'song.mp3', 'elsewhere.txt']);
    expect(result.current.dragOverlay).toMatchObject({
      totalCount: 3,
      pickupPoint: { x: 12, y: 18 },
      phase: 'gathering',
    });

    expect(result.current.dragPos).toEqual({ x: 12, y: 18 });

    act(() => result.current.handleGatherComplete());
    expect(result.current.dragOverlay?.phase).toBe('dragging');
  });

  it('switches to copy while Ctrl or Option is held and shows the operation verb', async () => {
    const { result, props } = renderDnd({ selectedPaths: ['/source/photo.png'] });
    act(() => result.current.beginDrag(props.files[0], { x: 10, y: 10 }));
    act(() => result.current.handleHoverFolder(props.files[1]));
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    );
    expect(result.current.dragOverlay?.operation).toBe('copy');
    act(() => window.dispatchEvent(new MouseEvent('mouseup')));

    await waitFor(() =>
      expect(mocks.copyWithUndoAndConflictResolution).toHaveBeenCalledWith(
        [props.files[0]],
        '/target/docs',
        expect.any(Function),
        props.refreshVisibleViews,
        { conflictResolution: 'ask' }
      )
    );
  });

  it('pins dragged folders when Favorites is the drop target', () => {
    const folder = file('projects', { path: '/source/projects', is_dir: true });
    const addFavorite = vi.fn();
    const { result } = renderDnd({ files: [folder], selectedPaths: [folder.path], addFavorite });

    act(() => result.current.beginDrag(folder, { x: 3, y: 4 }));
    act(() => result.current.handleHoverFavorites());
    act(() => window.dispatchEvent(new MouseEvent('mouseup')));

    expect(addFavorite).toHaveBeenCalledWith(folder.path, folder.name);
    expect(result.current.dragOverlay?.phase).toBe('dropping');
  });

  it('opens a hovered folder after the dwell delay', () => {
    vi.useFakeTimers();
    const onOpenFolder = vi.fn();
    const { result, props } = renderDnd({ onOpenFolder });
    act(() => result.current.beginDrag(props.files[0], { x: 1, y: 1 }));
    act(() => result.current.handleHoverFolder(props.files[1]));

    act(() => vi.advanceTimersByTime(699));
    expect(onOpenFolder).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenFolder).toHaveBeenCalledWith(props.files[1]);
  });

  it('drags an unselected item alone', () => {
    const { result, props } = renderDnd();

    act(() => {
      result.current.beginDrag(props.files[1], { x: 5, y: 6 });
    });

    expect([...result.current.draggingItemIds]).toEqual(['docs']);
    expect(result.current.dragOverlay?.totalCount).toBe(1);
  });

  it('moves the selected payload once and clears visual state only after the drop animation', async () => {
    const { result, props } = renderDnd({
      selectedPaths: ['/source/photo.png', '/source/song.mp3'],
    });

    act(() => {
      result.current.beginDrag(props.files[0], { x: 10, y: 10 });
    });
    act(() => result.current.handleHoverFolder(props.files[1]));
    act(() => window.dispatchEvent(new MouseEvent('mouseup')));

    await waitFor(() =>
      expect(mocks.moveWithUndoAndConflictResolution).toHaveBeenCalledWith(
        [props.files[0], props.files[2]],
        '/target/docs',
        expect.any(Function),
        props.refreshVisibleViews,
        { conflictResolution: 'ask' }
      )
    );
    expect(result.current.dragOverlay?.phase).toBe('dropping');
    expect(result.current.draggingItemIds.size).toBe(2);

    act(() => result.current.handleDragAnimationComplete());
    expect(result.current.dragOverlay).toBeNull();
    expect(result.current.draggingItemIds.size).toBe(0);
    expect(result.current.dndEpoch).toBe(1);
  });

  it('rejects same-folder, self, and descendant targets and returns ghosts to their origins', () => {
    const folder = file('folder', { path: '/source/folder', is_dir: true });
    const nested = file('nested', { path: '/source/folder/nested', is_dir: true });
    const getParentPath = (path: string) => path.split('/').slice(0, -1).join('/') || '/';

    expect(isValidDropTarget('/source', [folder], getParentPath)).toBe(false);
    expect(isValidDropTarget('/source/folder', [folder], getParentPath)).toBe(false);
    expect(isValidDropTarget('/source/folder/nested', [folder], getParentPath)).toBe(false);

    const { result } = renderDnd({ files: [folder, nested], getParentPath });
    act(() => result.current.beginDrag(folder, { x: 1, y: 2 }));
    act(() => result.current.handleHoverFolder(nested));
    expect(result.current.combineTargetId).toBeNull();

    act(() => window.dispatchEvent(new MouseEvent('pointerup')));
    expect(result.current.dragOverlay?.phase).toBe('returning');
    expect(mocks.moveWithUndoAndConflictResolution).not.toHaveBeenCalled();
  });

  it('finds column-mode targets, refreshes after move errors, and handles hidden-tab release', async () => {
    const refreshVisibleViews = vi.fn(async () => {});
    mocks.moveWithUndoAndConflictResolution.mockRejectedValueOnce(new Error('move failed'));
    const clip = file('clip.mp4', { path: '/columns/clip.mp4' });
    const target = file('videos', { path: '/videos', is_dir: true });
    const { result } = renderDnd({
      files: [],
      columnFiles: { '/columns': [clip, target] },
      viewMode: 'column',
      selectedPaths: ['/columns/clip.mp4'],
      refreshVisibleViews,
    });

    act(() => result.current.beginDrag(clip, { x: 4, y: 8 }));
    act(() => result.current.handleHoverFolder(target));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() =>
      expect(mocks.moveWithUndoAndConflictResolution).toHaveBeenCalledWith(
        [clip],
        '/videos',
        expect.any(Function),
        refreshVisibleViews,
        { conflictResolution: 'ask' }
      )
    );
    await waitFor(() => expect(refreshVisibleViews).toHaveBeenCalledTimes(1));
    expect(result.current.dragOverlay?.phase).toBe('dropping');
  });
});
