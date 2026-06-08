import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useNavigationHistory } from './useNavigationHistory';

describe('useNavigationHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('tracks back/forward navigation', () => {
    const { result, rerender } = renderHook(
      ({ tabId, currentPath }) => useNavigationHistory(tabId, currentPath),
      {
        initialProps: { tabId: 'tab-1', currentPath: '/a' },
      }
    );

    expect(result.current.canGoBack).toBe(false);

    act(() => {
      rerender({ tabId: 'tab-1', currentPath: '/b' });
    });

    expect(result.current.backHistory).toEqual(['/a']);
    expect(result.current.canGoBack).toBe(true);

    let target: string | null = null;
    act(() => {
      target = result.current.goBack();
    });

    expect(target).toBe('/a');

    act(() => {
      rerender({ tabId: 'tab-1', currentPath: target! });
    });

    expect(result.current.forwardHistory).toEqual(['/b']);

    act(() => {
      target = result.current.goForward();
    });

    expect(target).toBe('/b');
  });

  it('jumps to a specific back history index', () => {
    const { result, rerender } = renderHook(
      ({ tabId, currentPath }) => useNavigationHistory(tabId, currentPath),
      {
        initialProps: { tabId: 'tab-2', currentPath: '/one' },
      }
    );

    // Each rerender needs its own act() to allow the useEffect to run
    act(() => {
      rerender({ tabId: 'tab-2', currentPath: '/two' });
    });
    act(() => {
      rerender({ tabId: 'tab-2', currentPath: '/three' });
    });

    let target: string | null = null;
    act(() => {
      target = result.current.goToBackIndex(1);
    });

    expect(target).toBe('/one');
  });
});
