import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnounce } from './useAnnounce';

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  announceSelection: vi.fn(),
  announceOperation: vi.fn(),
  announceNavigation: vi.fn(),
}));

vi.mock('../utils/accessibility', () => ({
  announce: mocks.announce,
  announceSelection: mocks.announceSelection,
  announceOperation: mocks.announceOperation,
  announceNavigation: mocks.announceNavigation,
}));

describe('useAnnounce', () => {
  beforeEach(() => {
    mocks.announce.mockClear();
    mocks.announceSelection.mockClear();
    mocks.announceOperation.mockClear();
    mocks.announceNavigation.mockClear();
  });

  it('wraps accessibility announcement helpers with stable callbacks', () => {
    const { result, rerender } = renderHook(() => useAnnounce());
    const firstResult = result.current;

    act(() => {
      result.current.announce('Ready');
      result.current.announce('Failed', 'assertive');
      result.current.announceSelection(2, 5);
      result.current.announceOperation('Copy', false, 'Disk full');
      result.current.announceNavigation('/workspace/docs');
    });

    rerender();

    expect(result.current).toEqual(firstResult);
    expect(mocks.announce).toHaveBeenCalledWith('Ready', 'polite');
    expect(mocks.announce).toHaveBeenCalledWith('Failed', 'assertive');
    expect(mocks.announceSelection).toHaveBeenCalledWith(2, 5);
    expect(mocks.announceOperation).toHaveBeenCalledWith('Copy', false, 'Disk full');
    expect(mocks.announceNavigation).toHaveBeenCalledWith('/workspace/docs');
  });
});
