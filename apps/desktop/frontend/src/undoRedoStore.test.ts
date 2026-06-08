import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createValidationResult,
  generateOperationId,
  useCanRedo,
  useCanUndo,
  useUndoExpiration,
  useUndoRedoStore,
  useUndoTimeRemaining,
  type BatchRenameOperation,
  type CopyOperation,
  type CreateOperation,
  type DeleteOperation,
  type MoveOperation,
  type Operation,
  type RenameOperation,
} from './undoRedoStore';

type UndoWindow = Window &
  typeof globalThis & {
    __undoPruneInterval?: ReturnType<typeof setInterval>;
  };

const initialState = useUndoRedoStore.getState();
const now = Date.parse('2026-06-04T12:00:00Z');

function renameOperation(overrides: Partial<RenameOperation> = {}): RenameOperation {
  return {
    id: 'op-rename',
    type: 'rename',
    timestamp: now,
    description: 'Rename file',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    oldPath: '/root/a.txt',
    newPath: '/root/b.txt',
    oldName: 'a.txt',
    newName: 'b.txt',
    ...overrides,
  };
}

function deleteOperation(overrides: Partial<DeleteOperation> = {}): DeleteOperation {
  return {
    id: 'op-delete',
    type: 'delete',
    timestamp: now,
    description: 'Delete files',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    deletedItems: [{ path: '/root/a.txt', name: 'a.txt', isDir: false }],
    backups: [
      {
        originalPath: '/root/a.txt',
        trashPath: '/root/.Trash/a.txt',
        name: 'a.txt',
        isDir: false,
      },
    ],
    ...overrides,
  };
}

function moveOperation(overrides: Partial<MoveOperation> = {}): MoveOperation {
  return {
    id: 'op-move',
    type: 'move',
    timestamp: now,
    description: 'Move files',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    items: [{ sourcePath: '/root/a.txt', destPath: '/root/docs/a.txt', name: 'a.txt' }],
    ...overrides,
  };
}

function copyOperation(overrides: Partial<CopyOperation> = {}): CopyOperation {
  return {
    id: 'op-copy',
    type: 'copy',
    timestamp: now,
    description: 'Copy files',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    createdPaths: ['/root/docs/a.txt'],
    sourceItems: [{ path: '/root/a.txt', name: 'a.txt' }],
    ...overrides,
  };
}

function createOperation(overrides: Partial<CreateOperation> = {}): CreateOperation {
  return {
    id: 'op-create',
    type: 'create',
    timestamp: now,
    description: 'Create file',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    createdPath: '/root/new.txt',
    itemType: 'file',
    name: 'new.txt',
    content: 'hello',
    ...overrides,
  };
}

function batchRenameOperation(overrides: Partial<BatchRenameOperation> = {}): BatchRenameOperation {
  return {
    id: 'op-batch',
    type: 'batch_rename',
    timestamp: now,
    description: 'Batch rename',
    undo: vi.fn(async () => true),
    redo: vi.fn(async () => true),
    renames: [
      {
        oldPath: '/root/a.txt',
        newPath: '/root/a-1.txt',
        oldName: 'a.txt',
        newName: 'a-1.txt',
      },
    ],
    successCount: 1,
    ...overrides,
  };
}

function resetStore(overrides: Partial<ReturnType<typeof useUndoRedoStore.getState>> = {}) {
  useUndoRedoStore.setState(
    {
      ...initialState,
      undoStack: [],
      redoStack: [],
      maxStackSize: 50,
      maxStackBytes: 24 * 1024 * 1024,
      operationTimeoutMs: 60_000,
      isProcessing: false,
      ...overrides,
    },
    true
  );
}

function cleanupUndoExpirationInterval() {
  const undoWindow = window as UndoWindow;
  if (undoWindow.__undoPruneInterval) {
    clearInterval(undoWindow.__undoPruneInterval);
    delete undoWindow.__undoPruneInterval;
  }
}

describe('undo/redo helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    localStorage.clear();
    cleanupUndoExpirationInterval();
    resetStore();
  });

  it('creates validation results and monotonic operation ids', () => {
    expect(createValidationResult(false, 'file_missing', 'Missing file')).toEqual({
      valid: false,
      reason: 'file_missing',
      message: 'Missing file',
    });

    const first = generateOperationId();
    const second = generateOperationId();
    const firstCounter = Number(first.split('-').at(-1));
    const secondCounter = Number(second.split('-').at(-1));

    expect(first).toMatch(/^op-1780574400000-\d+$/);
    expect(secondCounter).toBe(firstCounter + 1);
  });
});

describe('useUndoRedoStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    localStorage.clear();
    cleanupUndoExpirationInterval();
    resetStore();
  });

  it('pushes every operation type, estimates memory, and clears redo history', () => {
    resetStore({ redoStack: [renameOperation({ id: 'redo-op' })] });
    const operations: Operation[] = [
      deleteOperation(),
      renameOperation(),
      moveOperation(),
      copyOperation(),
      createOperation(),
      batchRenameOperation(),
    ];

    operations.forEach((operation) => useUndoRedoStore.getState().push(operation));

    expect(useUndoRedoStore.getState().redoStack).toEqual([]);
    expect(useUndoRedoStore.getState().undoStack.map((operation) => operation.type)).toEqual([
      'delete',
      'rename',
      'move',
      'copy',
      'create',
      'batch_rename',
    ]);
    expect(useUndoRedoStore.getState().undoStack.every((operation) => operation.memoryBytes)).toBe(
      true
    );

    useUndoRedoStore.getState().push(renameOperation({ id: 'sized-op', memoryBytes: 777 }));
    expect(useUndoRedoStore.getState().undoStack.at(-1)?.memoryBytes).toBe(777);
  });

  it('trims undo and redo stacks by count and memory limits', async () => {
    resetStore({ maxStackSize: 2 });
    useUndoRedoStore.getState().push(renameOperation({ id: 'op-1' }));
    useUndoRedoStore.getState().push(renameOperation({ id: 'op-2' }));
    useUndoRedoStore.getState().push(renameOperation({ id: 'op-3' }));

    expect(useUndoRedoStore.getState().undoStack.map((operation) => operation.id)).toEqual([
      'op-2',
      'op-3',
    ]);

    resetStore({ maxStackBytes: 20 });
    useUndoRedoStore.getState().push(renameOperation({ id: 'small-1', memoryBytes: 15 }));
    useUndoRedoStore.getState().push(renameOperation({ id: 'small-2', memoryBytes: 15 }));

    expect(useUndoRedoStore.getState().undoStack.map((operation) => operation.id)).toEqual([
      'small-2',
    ]);

    resetStore({ maxStackSize: 1 });
    const first = renameOperation({ id: 'undo-1' });
    const second = renameOperation({ id: 'undo-2' });
    useUndoRedoStore.getState().push(first);
    useUndoRedoStore.getState().push(second);

    await useUndoRedoStore.getState().undo();
    await useUndoRedoStore.getState().redo();

    expect(useUndoRedoStore.getState().undoStack.map((operation) => operation.id)).toEqual([
      'undo-2',
    ]);
  });

  it('supports successful undo and redo transitions', async () => {
    const undoFn = vi.fn(async () => true);
    const redoFn = vi.fn(async () => true);
    const operation = renameOperation({ undo: undoFn, redo: redoFn });

    useUndoRedoStore.getState().push(operation);
    expect(useUndoRedoStore.getState().canUndo()).toBe(true);
    expect(useUndoRedoStore.getState().canRedo()).toBe(false);

    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(true);
    expect(undoFn).toHaveBeenCalledTimes(1);
    expect(useUndoRedoStore.getState().undoStack).toHaveLength(0);
    expect(useUndoRedoStore.getState().redoStack).toHaveLength(1);

    await expect(useUndoRedoStore.getState().redo()).resolves.toBe(true);
    expect(redoFn).toHaveBeenCalledTimes(1);
    expect(useUndoRedoStore.getState().undoStack).toHaveLength(1);
    expect(useUndoRedoStore.getState().redoStack).toHaveLength(0);
  });

  it('returns false without mutating stacks while empty, processing, or operation functions fail', async () => {
    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(false);
    await expect(useUndoRedoStore.getState().redo()).resolves.toBe(false);

    const blockedUndo = renameOperation({ undo: vi.fn(async () => true) });
    resetStore({ undoStack: [blockedUndo], isProcessing: true });
    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(false);
    expect(blockedUndo.undo).not.toHaveBeenCalled();

    const failedUndo = renameOperation({ id: 'failed-undo', undo: vi.fn(async () => false) });
    resetStore({ undoStack: [failedUndo] });
    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(false);
    expect(useUndoRedoStore.getState().undoStack).toEqual([failedUndo]);
    expect(useUndoRedoStore.getState().redoStack).toEqual([]);

    const failedRedo = renameOperation({ id: 'failed-redo', redo: vi.fn(async () => false) });
    resetStore({ redoStack: [failedRedo] });
    await expect(useUndoRedoStore.getState().redo()).resolves.toBe(false);
    expect(useUndoRedoStore.getState().redoStack).toEqual([failedRedo]);
  });

  it('handles thrown undo and redo errors and always clears processing state', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const undoError = new Error('undo failed');
    const redoError = new Error('redo failed');

    resetStore({
      undoStack: [renameOperation({ undo: vi.fn(async () => Promise.reject(undoError)) })],
    });
    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(false);
    expect(useUndoRedoStore.getState().isProcessing).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('Undo failed:', undoError);

    resetStore({
      redoStack: [renameOperation({ redo: vi.fn(async () => Promise.reject(redoError)) })],
    });
    await expect(useUndoRedoStore.getState().redo()).resolves.toBe(false);
    expect(useUndoRedoStore.getState().isProcessing).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('Redo failed:', redoError);
  });

  it('prunes expired operations and rejects expired undo attempts', async () => {
    const expired = deleteOperation({
      id: 'op-expired',
      timestamp: now - 10_000,
    });
    const valid = deleteOperation({ id: 'op-valid' });

    resetStore({ operationTimeoutMs: 1, undoStack: [expired] });
    useUndoRedoStore.getState().pruneExpiredOperations();
    expect(useUndoRedoStore.getState().undoStack).toEqual([]);

    resetStore({ operationTimeoutMs: 1, undoStack: [expired] });
    await expect(useUndoRedoStore.getState().undo()).resolves.toBe(false);
    expect(expired.undo).not.toHaveBeenCalled();
    expect(useUndoRedoStore.getState().undoStack).toEqual([]);

    const expiredTop = deleteOperation({
      id: 'op-expired-top',
      timestamp: now - 120_000,
    });
    resetStore({ undoStack: [valid, expiredTop] });
    expect(useUndoRedoStore.getState().getLastUndo()).toEqual(valid);
    expect(useUndoRedoStore.getState().canUndo()).toBe(false);
  });

  it('clears stacks and redo stack independently', () => {
    resetStore({
      undoStack: [renameOperation({ id: 'undo-op' })],
      redoStack: [renameOperation({ id: 'redo-op' })],
    });

    useUndoRedoStore.getState().clearRedo();
    expect(useUndoRedoStore.getState().undoStack).toHaveLength(1);
    expect(useUndoRedoStore.getState().redoStack).toEqual([]);

    useUndoRedoStore.getState().clear();
    expect(useUndoRedoStore.getState().undoStack).toEqual([]);
    expect(useUndoRedoStore.getState().redoStack).toEqual([]);
  });

  it('clamps operation timeout, persists it, and computes operation validity windows', () => {
    const operation = renameOperation({ timestamp: now - 30_000 });

    useUndoRedoStore.getState().setOperationTimeout(0);
    expect(useUndoRedoStore.getState().operationTimeoutMs).toBe(60_000);
    expect(localStorage.getItem('explorie:undoTimeoutMinutes')).toBe('1');

    useUndoRedoStore.getState().setOperationTimeout(100);
    expect(useUndoRedoStore.getState().operationTimeoutMs).toBe(3_600_000);
    expect(localStorage.getItem('explorie:undoTimeoutMinutes')).toBe('60');

    useUndoRedoStore.getState().setOperationTimeout(1);
    expect(useUndoRedoStore.getState().isOperationValid(operation)).toBe(true);
    expect(useUndoRedoStore.getState().getOperationTimeRemaining(operation)).toBe(30);

    vi.setSystemTime(now + 90_000);
    expect(useUndoRedoStore.getState().isOperationValid(operation)).toBe(false);
    expect(useUndoRedoStore.getState().getOperationTimeRemaining(operation)).toBe(0);
  });

  it('validates expired and supported operation types', () => {
    const expired = renameOperation({ timestamp: now - 120_000 });
    expect(useUndoRedoStore.getState().validateOperation(expired)).toEqual({
      valid: false,
      reason: 'expired',
      message: 'Operation expired (undo only available for 1 minutes)',
    });

    const operations: Operation[] = [
      deleteOperation(),
      renameOperation(),
      moveOperation(),
      copyOperation(),
      createOperation(),
      batchRenameOperation(),
    ];

    operations.forEach((operation) => {
      expect(useUndoRedoStore.getState().validateOperation(operation)).toEqual({ valid: true });
    });
  });

  it('exposes computed redo and last redo state', () => {
    const redo = renameOperation({ id: 'redo-op' });
    resetStore({ redoStack: [redo] });

    expect(useUndoRedoStore.getState().canRedo()).toBe(true);
    expect(useUndoRedoStore.getState().getLastRedo()).toEqual(redo);

    resetStore({ redoStack: [redo], isProcessing: true });
    expect(useUndoRedoStore.getState().canRedo()).toBe(false);
  });
});

describe('undo/redo hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    localStorage.clear();
    cleanupUndoExpirationInterval();
    resetStore();
  });

  it('reports undo, redo, and timeout state through hooks', () => {
    resetStore({
      undoStack: [renameOperation({ id: 'undo-op', timestamp: now - 10_000 })],
      redoStack: [renameOperation({ id: 'redo-op' })],
      operationTimeoutMs: 60_000,
    });

    expect(renderHook(() => useCanUndo()).result.current).toBe(true);
    expect(renderHook(() => useCanRedo()).result.current).toBe(true);
    expect(renderHook(() => useUndoTimeRemaining()).result.current).toBe(50);

    resetStore({ undoStack: [renameOperation({ timestamp: now - 120_000 })] });
    expect(renderHook(() => useCanUndo()).result.current).toBe(false);
    expect(renderHook(() => useUndoTimeRemaining()).result.current).toBeNull();

    resetStore();
    expect(renderHook(() => useUndoTimeRemaining()).result.current).toBeNull();
  });

  it('sets up a single automatic expiration interval', () => {
    const expired = renameOperation({ timestamp: now - 10_000 });
    resetStore({ operationTimeoutMs: 1, undoStack: [expired] });

    renderHook(() => useUndoExpiration());
    const firstInterval = (window as UndoWindow).__undoPruneInterval;
    renderHook(() => useUndoExpiration());

    expect((window as UndoWindow).__undoPruneInterval).toBe(firstInterval);

    vi.advanceTimersByTime(30_000);
    expect(useUndoRedoStore.getState().undoStack).toEqual([]);
  });
});
