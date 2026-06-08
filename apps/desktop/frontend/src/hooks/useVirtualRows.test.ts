import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVirtualRows } from './useVirtualRows';

let virtualItems: Array<{ index: number; start: number; size: number; key: number }> = [];
let totalSize = 0;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: () => virtualItems,
    getTotalSize: () => totalSize,
  })),
}));

describe('useVirtualRows', () => {
  beforeEach(() => {
    virtualItems = [{ index: 0, start: 0, size: 10, key: 0 }];
    totalSize = 10;
  });

  it('freezes virtual rows when requested', () => {
    const parent = document.createElement('div');
    const parentRef = { current: parent };

    const { result, rerender } = renderHook(
      ({ freeze }) => useVirtualRows({ count: 1, parentRef, freeze }),
      { initialProps: { freeze: true } }
    );

    expect(result.current.virtualRows).toHaveLength(1);
    expect(result.current.totalSize).toBe(10);

    virtualItems = [
      { index: 0, start: 0, size: 10, key: 0 },
      { index: 1, start: 10, size: 10, key: 1 },
    ];
    totalSize = 20;

    rerender({ freeze: true });
    expect(result.current.virtualRows).toHaveLength(1);

    rerender({ freeze: false });
    expect(result.current.virtualRows).toHaveLength(2);
    expect(result.current.totalSize).toBe(20);
  });
});
