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
});
