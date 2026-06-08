import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDirSize } from './useDirSize';

const getCachedDirSize = vi.fn();
const setCachedDirSize = vi.fn();
const invoke = vi.fn();

vi.mock('../dirSizeCache', () => ({
  getCachedDirSize: (...args: unknown[]) => getCachedDirSize(...args),
  setCachedDirSize: (...args: unknown[]) => setCachedDirSize(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useDirSize', () => {
  beforeEach(() => {
    getCachedDirSize.mockReset();
    setCachedDirSize.mockReset();
    invoke.mockReset();
    delete (window as any).__explorieInflightSizes;
  });

  it('returns cached values without invoking backend', () => {
    getCachedDirSize.mockReturnValue(123);

    const { result } = renderHook(() => useDirSize('/root', true));
    expect(result.current[0]).toBe(123);
    expect(result.current[1]).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fetches sizes when cache is empty', async () => {
    getCachedDirSize.mockReturnValue(undefined);
    invoke.mockResolvedValue(55);

    const { result } = renderHook(() => useDirSize('/root', true));

    await waitFor(() => expect(result.current[0]).toBe(55));
    expect(result.current[1]).toBe(false);
    expect(setCachedDirSize).toHaveBeenCalledWith('/root', 55);
  });

  it('deduplicates inflight requests', async () => {
    getCachedDirSize.mockReturnValue(undefined);
    const deferred = createDeferred<number>();
    invoke.mockReturnValue(deferred.promise);

    const hook1 = renderHook(() => useDirSize('/root', true));
    const hook2 = renderHook(() => useDirSize('/root', true));

    expect(invoke).toHaveBeenCalledTimes(1);

    deferred.resolve(42);

    await waitFor(() => expect(hook1.result.current[0]).toBe(42));
    await waitFor(() => expect(hook2.result.current[0]).toBe(42));
  });
});
