import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOperationQueueStore } from '../operationQueueStore';
import type { FileEntry } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';

const mocks = vi.hoisted(() => ({
  handler: undefined as ((event: { payload: unknown }) => void) | undefined,
  invoke: vi.fn(),
  unlisten: vi.fn(),
  checkForConflict: vi.fn(),
  resetConflicts: vi.fn(),
  queueConflict: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handler = handler;
    return mocks.unlisten;
  }),
}));
vi.mock('../conflictResolutionStore', () => ({
  checkForConflict: mocks.checkForConflict,
  useConflictResolutionStore: {
    getState: () => ({
      reset: mocks.resetConflicts,
      queueConflict: mocks.queueConflict,
    }),
  },
}));

import {
  copyWithUndoAndConflictResolution,
  moveWithUndoAndConflictResolution,
} from './fileOperations';

function file(path: string): FileEntry {
  return {
    id: path,
    path,
    name: path.split('/').pop() || path,
    size: 128,
    modified: new Date().toISOString(),
    hidden: false,
    is_dir: false,
    custom: {},
  };
}

describe('production bulk file operation integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handler = undefined;
    mocks.checkForConflict.mockResolvedValue(null);
    useOperationQueueStore.setState({ operations: [], showProgressPanel: false });
    useUndoRedoStore.setState({ undoStack: [], redoStack: [] });
  });

  it.each(['copy', 'move'] as const)(
    'routes multi-item %s through one queue operation and one aggregate event stream',
    async (kind) => {
      const files = [file('/source/one.txt'), file('/source/two.txt')];
      const jobId = `job-${kind}`;
      const targets = ['/destination/one.txt', '/destination/two.txt'];
      const snapshots: Array<{
        id: string;
        processedItems: number;
        totalItems: number;
        processedBytes: number;
        totalBytes: number;
      }> = [];
      const unsubscribe = useOperationQueueStore.subscribe((state) => {
        const operation = state.operations[0];
        if (operation) {
          snapshots.push({
            id: operation.id,
            processedItems: operation.processedItems,
            totalItems: operation.totalItems,
            processedBytes: operation.processedBytes,
            totalBytes: operation.totalBytes,
          });
        }
      });

      mocks.invoke.mockImplementation(async (command: string) => {
        expect(command).toBe('start_file_operation');
        for (const progress of [
          { processedEntries: 0, processedBytes: 0, currentPath: null },
          { processedEntries: 1, processedBytes: 128, currentPath: files[0].path },
          { processedEntries: 2, processedBytes: 256, currentPath: files[1].path },
        ]) {
          mocks.handler?.({
            payload: {
              jobId,
              state: 'running',
              progress: {
                ...progress,
                totalEntries: 2,
                totalBytes: 256,
              },
            },
          });
        }
        mocks.handler?.({
          payload: {
            jobId,
            state: 'completed',
            result: { processedEntries: 2, processedBytes: 256, targets },
          },
        });
        return jobId;
      });

      const mutate =
        kind === 'copy' ? copyWithUndoAndConflictResolution : moveWithUndoAndConflictResolution;
      await expect(
        mutate(files, '/destination', vi.fn(), vi.fn().mockResolvedValue(undefined))
      ).resolves.toBe(true);
      unsubscribe();

      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith('start_file_operation', {
        request: {
          kind,
          sources: files.map((item) => item.path),
          destination: '/destination',
          conflictPolicy: 'error',
          conflictPolicies: ['error', 'error'],
        },
      });
      expect(useOperationQueueStore.getState().operations).toHaveLength(1);
      expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
        id: jobId,
        type: kind,
        status: 'completed',
        processedItems: 2,
        totalItems: 2,
        processedBytes: 256,
        totalBytes: 256,
      });
      expect(new Set(snapshots.map((snapshot) => snapshot.id))).toEqual(new Set([jobId]));
      expect(snapshots.some((snapshot) => snapshot.processedItems === 1)).toBe(true);
      expect(
        snapshots.every((snapshot) => snapshot.totalItems === 2 && snapshot.totalBytes === 256)
      ).toBe(true);
      expect(
        snapshots.every(
          (snapshot, index) =>
            index === 0 ||
            (snapshot.processedItems >= snapshots[index - 1].processedItems &&
              snapshot.processedBytes >= snapshots[index - 1].processedBytes)
        )
      ).toBe(true);
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    }
  );
});
