import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOperationQueueStore } from '../operationQueueStore';
import { runNativeFileOperation } from './nativeFileOperations';

const mocks = vi.hoisted(() => ({
  handler: undefined as ((event: { payload: unknown }) => void) | undefined,
  invoke: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handler = handler;
    return mocks.unlisten;
  }),
}));

describe('runNativeFileOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handler = undefined;
    useOperationQueueStore.setState({ operations: [], showProgressPanel: false });
  });

  it('tracks early progress and completion events from the native job', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      expect(command).toBe('start_file_operation');
      mocks.handler?.({
        payload: {
          jobId: 'job-1',
          state: 'running',
          progress: {
            processedEntries: 1,
            totalEntries: 1,
            processedBytes: 7,
            totalBytes: 7,
            currentPath: '/source/a.txt',
          },
        },
      });
      mocks.handler?.({
        payload: {
          jobId: 'job-1',
          state: 'completed',
          result: { processedEntries: 1, processedBytes: 7, targets: ['/target/a.txt'] },
        },
      });
      return 'job-1';
    });

    await expect(
      runNativeFileOperation(
        {
          kind: 'copy',
          sources: ['/source/a.txt'],
          destination: '/target',
          conflictPolicy: 'error',
        },
        {
          type: 'copy',
          items: [{ sourcePath: '/source/a.txt', size: 7, name: 'a.txt', isDir: false }],
          destinationPath: '/target',
          conflictResolution: 'ask',
        }
      )
    ).resolves.toEqual({
      processedEntries: 1,
      processedBytes: 7,
      targets: ['/target/a.txt'],
    });

    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      id: 'job-1',
      status: 'completed',
      processedBytes: 7,
      processedItems: 1,
    });
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it.each(['copy', 'move'] as const)(
    'mirrors one aggregate %s event stream and preserves mid-job progress on cancel',
    async (kind) => {
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === 'start_file_operation') return 'job-bulk';
        if (command === 'cancel_file_operation') return true;
        throw new Error(`Unexpected command: ${command}`);
      });
      const items = [0, 1, 2].map((index) => ({
        sourcePath: `/source/item-${index}.txt`,
        size: 10,
        name: `item-${index}.txt`,
        isDir: false,
      }));

      const operation = runNativeFileOperation(
        {
          kind,
          sources: items.map((item) => item.sourcePath),
          destination: '/target',
          conflictPolicy: 'error',
        },
        {
          type: kind,
          items,
          destinationPath: '/target',
          conflictResolution: 'ask',
        }
      );
      const cancelled = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => {
        expect(useOperationQueueStore.getState().operations).toHaveLength(1);
      });

      mocks.handler?.({
        payload: {
          jobId: 'job-bulk',
          state: 'running',
          progress: {
            processedEntries: 2,
            totalEntries: 3,
            processedBytes: 20,
            totalBytes: 30,
            currentPath: '/source/item-1.txt',
          },
        },
      });
      await useOperationQueueStore.getState().cancelOperation('job-bulk');
      mocks.handler?.({ payload: { jobId: 'job-bulk', state: 'cancelled' } });
      await cancelled;

      expect(mocks.invoke).toHaveBeenCalledWith('cancel_file_operation', { jobId: 'job-bulk' });
      expect(useOperationQueueStore.getState().operations).toHaveLength(1);
      expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
        id: 'job-bulk',
        status: 'cancelled',
        processedItems: 2,
        totalItems: 3,
        processedBytes: 20,
        totalBytes: 30,
        currentItem: '/source/item-1.txt',
      });
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    }
  );
});
