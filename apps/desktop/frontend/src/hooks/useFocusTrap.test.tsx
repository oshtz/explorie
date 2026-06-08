import React, { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function FocusTrapHarness({
  enabled = true,
  initial = false,
  restoreFocus = true,
}: {
  enabled?: boolean;
  initial?: boolean;
  restoreFocus?: boolean;
}) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const { containerRef, handleKeyDown } = useFocusTrap<HTMLDivElement>({
    enabled,
    initialFocusRef: initial
      ? (initialFocusRef as unknown as React.RefObject<HTMLElement>)
      : undefined,
    restoreFocus,
  });

  return (
    <div ref={containerRef} onKeyDown={handleKeyDown}>
      <button type="button">First</button>
      <button type="button" ref={initialFocusRef}>
        Middle
      </button>
      <button type="button">Last</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  afterEach(() => {
    cleanup();
  });

  it('focuses the initial focus ref and restores the previous focus on unmount', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<FocusTrapHarness initial />);

    expect(screen.getByRole('button', { name: 'Middle' })).toHaveFocus();

    unmount();

    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('focuses the first focusable element by default and wraps Tab navigation', () => {
    render(<FocusTrapHarness />);

    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('does not move focus when disabled or when restoreFocus is false', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<FocusTrapHarness enabled={false} restoreFocus={false} />);

    expect(outside).toHaveFocus();

    screen.getByRole('button', { name: 'First' }).focus();
    unmount();

    expect(outside).not.toHaveFocus();
    outside.remove();
  });
});
