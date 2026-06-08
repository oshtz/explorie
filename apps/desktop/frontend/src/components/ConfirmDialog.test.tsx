import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Delete file"
        message="Delete report.md?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirms destructive actions and propagates the dont-ask-again choice', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onDontAskAgainChange = vi.fn();

    render(
      <ConfirmDialog
        open
        title="Delete file"
        message="Delete report.md?"
        confirmLabel="Delete"
        destructive
        showDontAskAgain
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        onDontAskAgainChange={onDontAskAgainChange}
      />
    );

    expect(screen.getByRole('alertdialog', { name: 'Delete file' })).toBeInTheDocument();
    expect(screen.getByText('Delete report.md?')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /don't ask again/i }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDontAskAgainChange).toHaveBeenCalledWith(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels from Escape and backdrop clicks', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();

    const { container } = render(
      <ConfirmDialog
        open
        title="Overwrite file"
        message="Replace existing file?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(container.firstElementChild as Element);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
