import { renderHook } from '@testing-library/react';
import { stat } from '@tauri-apps/plugin-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForConflict,
  useConflictOperationType,
  useConflictProgress,
  useConflictResolutionStore,
  useCurrentConflict,
  useIsConflictDialogOpen,
  type ConflictInfo,
} from './conflictResolutionStore';
import { fileExists, joinPaths } from './utils/fs';

vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(),
}));

vi.mock('./utils/fs', () => ({
  fileExists: vi.fn(),
  joinPaths: vi.fn((dir: string, name: string) => `${dir}/${name}`),
}));

const initialState = useConflictResolutionStore.getState();

const mockedFileExists = vi.mocked(fileExists);
const mockedJoinPaths = vi.mocked(joinPaths);
const mockedStat = vi.mocked(stat);

function createConflict(overrides: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    sourcePath: '/source/report.pdf',
    sourceName: 'report.pdf',
    sourceSize: 2048,
    sourceModified: new Date('2026-06-03T08:00:00.000Z'),
    sourceIsDir: false,
    destPath: '/dest/report.pdf',
    destName: 'report.pdf',
    destSize: 1024,
    destModified: new Date('2026-06-02T08:00:00.000Z'),
    destIsDir: false,
    ...overrides,
  };
}

function resetStore() {
  useConflictResolutionStore.setState(
    {
      ...initialState,
      conflicts: [],
      currentIndex: 0,
      operationType: 'copy',
      isOpen: false,
      applyToAllAction: null,
    },
    true
  );
}

describe('useConflictResolutionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('queues a conflict, exposes selector state, and resolves it', async () => {
    const conflict = createConflict();

    const resolution = useConflictResolutionStore.getState().queueConflict(conflict);

    expect(useConflictResolutionStore.getState().getCurrentConflict()).toEqual(conflict);
    expect(useConflictResolutionStore.getState().getTotalConflicts()).toBe(1);

    expect(renderHook(() => useIsConflictDialogOpen()).result.current).toBe(true);
    expect(renderHook(() => useCurrentConflict()).result.current).toEqual(conflict);
    expect(renderHook(() => useConflictOperationType()).result.current).toBe('copy');
    expect(renderHook(() => useConflictProgress()).result.current).toEqual({
      current: 1,
      total: 1,
    });

    useConflictResolutionStore.getState().resolveConflict('replace', false);

    await expect(resolution).resolves.toBe('replace');
    expect(useConflictResolutionStore.getState()).toMatchObject({
      conflicts: [],
      currentIndex: 0,
      isOpen: false,
    });
  });

  it('walks multiple queued conflicts one at a time', async () => {
    const first = createConflict({ sourceName: 'first.txt', destName: 'first.txt' });
    const second = createConflict({ sourceName: 'second.txt', destName: 'second.txt' });

    const firstResolution = useConflictResolutionStore.getState().queueConflict(first);
    const secondResolution = useConflictResolutionStore.getState().queueConflict(second);

    expect(useConflictResolutionStore.getState().getTotalConflicts()).toBe(2);

    useConflictResolutionStore.getState().resolveConflict('skip', false);

    await expect(firstResolution).resolves.toBe('skip');
    expect(useConflictResolutionStore.getState().currentIndex).toBe(1);
    expect(useConflictResolutionStore.getState().getCurrentConflict()).toEqual(second);
    expect(useConflictResolutionStore.getState().isOpen).toBe(true);

    useConflictResolutionStore.getState().resolveConflict('keepBoth', false);

    await expect(secondResolution).resolves.toBe('keepBoth');
    expect(useConflictResolutionStore.getState()).toMatchObject({
      conflicts: [],
      currentIndex: 0,
      isOpen: false,
    });
  });

  it('applies one action to all queued and future conflicts until reset', async () => {
    const firstResolution = useConflictResolutionStore
      .getState()
      .queueConflict(createConflict({ sourceName: 'a.txt' }));
    const secondResolution = useConflictResolutionStore
      .getState()
      .queueConflict(createConflict({ sourceName: 'b.txt' }));

    useConflictResolutionStore.getState().resolveConflict('replace', true);

    await expect(Promise.all([firstResolution, secondResolution])).resolves.toEqual([
      'replace',
      'replace',
    ]);
    expect(useConflictResolutionStore.getState()).toMatchObject({
      conflicts: [],
      isOpen: false,
      applyToAllAction: 'replace',
    });

    await expect(
      useConflictResolutionStore.getState().queueConflict(createConflict({ sourceName: 'c.txt' }))
    ).resolves.toBe('replace');
    expect(useConflictResolutionStore.getState().conflicts).toEqual([]);

    useConflictResolutionStore.getState().reset('move');
    expect(useConflictResolutionStore.getState()).toMatchObject({
      operationType: 'move',
      applyToAllAction: null,
      isOpen: false,
    });
  });

  it('cancels all pending conflicts as skipped', async () => {
    const firstResolution = useConflictResolutionStore
      .getState()
      .queueConflict(createConflict({ sourceName: 'a.txt' }));
    const secondResolution = useConflictResolutionStore
      .getState()
      .queueConflict(createConflict({ sourceName: 'b.txt' }));

    useConflictResolutionStore.getState().setOperationType('move');
    expect(useConflictResolutionStore.getState().operationType).toBe('move');

    useConflictResolutionStore.getState().cancelAll();

    await expect(Promise.all([firstResolution, secondResolution])).resolves.toEqual([
      'skip',
      'skip',
    ]);
    expect(useConflictResolutionStore.getState()).toMatchObject({
      conflicts: [],
      currentIndex: 0,
      isOpen: false,
      applyToAllAction: null,
    });
  });
});

describe('checkForConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the destination path does not exist', async () => {
    mockedFileExists.mockResolvedValue(false);

    await expect(checkForConflict('/source/report.pdf', '/dest', false)).resolves.toBeNull();

    expect(mockedJoinPaths).toHaveBeenCalledWith('/dest', 'report.pdf');
    expect(mockedFileExists).toHaveBeenCalledWith('/dest/report.pdf');
    expect(mockedStat).not.toHaveBeenCalled();
  });

  it('builds conflict info from source and destination stats', async () => {
    mockedFileExists.mockResolvedValue(true);
    mockedStat
      .mockResolvedValueOnce({
        size: 4096,
        mtime: new Date('2026-06-01T00:00:00.000Z'),
        isDirectory: false,
      } as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce({
        size: 1024,
        mtime: new Date('2026-05-31T00:00:00.000Z'),
        isDirectory: true,
      } as Awaited<ReturnType<typeof stat>>);

    await expect(checkForConflict('/source/report.pdf', '/dest', false)).resolves.toMatchObject({
      sourcePath: '/source/report.pdf',
      sourceName: 'report.pdf',
      sourceSize: 4096,
      sourceModified: new Date('2026-06-01T00:00:00.000Z'),
      sourceIsDir: false,
      destPath: '/dest/report.pdf',
      destName: 'report.pdf',
      destSize: 1024,
      destModified: new Date('2026-05-31T00:00:00.000Z'),
      destIsDir: true,
    });
  });

  it('keeps conflict info usable when stat calls fail', async () => {
    mockedFileExists.mockResolvedValue(true);
    mockedStat.mockRejectedValue(new Error('permission denied'));

    await expect(checkForConflict('/source/Assets', '/dest', true)).resolves.toMatchObject({
      sourcePath: '/source/Assets',
      sourceName: 'Assets',
      sourceSize: undefined,
      sourceModified: undefined,
      sourceIsDir: true,
      destPath: '/dest/Assets',
      destName: 'Assets',
      destSize: undefined,
      destModified: undefined,
      destIsDir: false,
    });
  });
});
