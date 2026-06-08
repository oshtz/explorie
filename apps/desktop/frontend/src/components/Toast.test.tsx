import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function ToastControls({ onAction }: { onAction: () => void }) {
  const { show, dismissAll } = useToast();

  return (
    <div>
      <button onClick={() => show('Saved changes', { type: 'success', duration: 0 })}>
        Show success
      </button>
      <button
        onClick={() =>
          show('Moved to Trash', {
            type: 'warning',
            duration: 0,
            action: { label: 'Undo', onClick: onAction },
          })
        }
      >
        Show action
      </button>
      <button onClick={() => show('Temporary notice', { type: 'info', duration: 1000 })}>
        Show timed
      </button>
      <button onClick={dismissAll}>Dismiss all</button>
    </div>
  );
}

function renderToasts(onAction = vi.fn()) {
  return {
    onAction,
    ...render(
      <ToastProvider>
        <ToastControls onAction={onAction} />
      </ToastProvider>
    ),
  };
}

describe('ToastProvider', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows a toast and dismisses it manually', async () => {
    vi.useFakeTimers();
    renderToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Show success' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Saved changes');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.queryByText('Saved changes')).not.toBeInTheDocument();
  });

  it('runs toast actions before dismissing the toast', async () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    renderToasts(onAction);

    fireEvent.click(screen.getByRole('button', { name: 'Show action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Moved to Trash')).not.toBeInTheDocument();
  });

  it('pauses auto-dismiss timers while hovered', async () => {
    vi.useFakeTimers();
    renderToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Show timed' }));
    const alert = screen.getByRole('alert');

    fireEvent.mouseEnter(alert);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByText('Temporary notice')).toBeInTheDocument();

    fireEvent.mouseLeave(alert);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.queryByText('Temporary notice')).not.toBeInTheDocument();
  });

  it('dismisses all active toasts through context', async () => {
    vi.useFakeTimers();
    renderToasts();

    fireEvent.click(screen.getByRole('button', { name: 'Show success' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show action' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
