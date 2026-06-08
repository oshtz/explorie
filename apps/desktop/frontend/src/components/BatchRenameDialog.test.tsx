import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { BatchRenameDialog } from './BatchRenameDialog';

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

function file(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: name,
    path: `/workspace/${name}`,
    name,
    size: 128,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof BatchRenameDialog>> = {}) {
  const props: React.ComponentProps<typeof BatchRenameDialog> = {
    open: true,
    files: [file('draft.txt'), file('notes.txt')],
    onClose: vi.fn(),
    onApply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    user: userEvent.setup(),
    props,
    ...render(<BatchRenameDialog {...props} />),
  };
}

describe('BatchRenameDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('heading', { name: 'Batch Rename' })).not.toBeInTheDocument();
  });

  it('previews find-and-replace changes and applies only changed files', async () => {
    const { user, props } = renderDialog({
      files: [file('draft.txt'), file('notes.txt')],
    });

    await user.type(screen.getByPlaceholderText('Text to find...'), 'draft');
    await user.type(screen.getByPlaceholderText('Replacement text...'), 'final');

    expect(screen.getByText('final.txt')).toBeVisible();
    expect(screen.getByText('1 changes')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Rename 1 Files' }));

    expect(props.onApply).toHaveBeenCalledWith([
      {
        oldPath: '/workspace/draft.txt',
        newName: 'final.txt',
      },
    ]);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks apply when preview names conflict after case conversion', async () => {
    const { user, props } = renderDialog({
      files: [file('Report.txt'), file('report.txt')],
    });

    await user.click(screen.getByRole('button', { name: 'Case' }));

    expect(screen.getByText('1 conflicts')).toBeVisible();
    expect(screen.getByTitle('Duplicate name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename 1 Files' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Rename 1 Files' }));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('blocks apply for invalid names', async () => {
    const { user, props } = renderDialog({
      files: [file('draft.txt')],
    });

    await user.type(screen.getByPlaceholderText('Text to find...'), 'draft');
    await user.type(screen.getByPlaceholderText('Replacement text...'), 'bad/name');

    expect(screen.getByText('1 invalid')).toBeVisible();
    expect(screen.getByTitle('Invalid name: Name cannot contain path separators')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename 1 Files' })).toBeDisabled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('previews sequential numbering with custom start, digits, and position', async () => {
    const { user, container } = renderDialog({
      files: [file('alpha.txt'), file('beta.txt')],
    });

    await user.click(screen.getByRole('button', { name: 'Numbering' }));

    const numberInputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
    fireEvent.change(numberInputs[0], { target: { value: '5' } });
    fireEvent.change(numberInputs[1], { target: { value: '2' } });

    const positionSelect = screen.getByRole('combobox');
    await user.selectOptions(positionSelect, 'prefix');

    expect(screen.getByText('05_alpha.txt')).toBeVisible();
    expect(screen.getByText('06_beta.txt')).toBeVisible();
    expect(screen.getByText('2 changes')).toBeVisible();
  });

  it('previews regex and date-time renames', async () => {
    vi.setSystemTime(new Date('2026-06-03T08:09:10Z'));
    const { user, rerender, props } = renderDialog({
      files: [file('photo-001.jpg')],
    });

    await user.click(screen.getByRole('button', { name: 'Regex' }));
    await user.type(screen.getByPlaceholderText('e.g., (\\d+)'), '(\\d+)');
    await user.type(screen.getByPlaceholderText('e.g., $1_new'), 'final-$1');

    expect(screen.getByText('photo-final-001.jpg')).toBeVisible();

    rerender(
      <BatchRenameDialog
        {...props}
        files={[
          file('photo.jpg', {
            modified: '2026-02-04T10:11:12Z',
          }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Date/Time' }));
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], 'modified');
    await user.selectOptions(selects[1], 'YYYYMMDD');

    const preview = screen.getByText('20260204_photo.jpg');
    expect(preview).toBeVisible();
  });

  it('keeps the dialog open and re-enables apply when applying fails', async () => {
    const { user, props } = renderDialog({
      files: [file('draft.txt')],
      onApply: vi.fn().mockRejectedValue(new Error('rename failed')),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await user.type(screen.getByPlaceholderText('Text to find...'), 'draft');
    await user.type(screen.getByPlaceholderText('Replacement text...'), 'final');
    await user.click(screen.getByRole('button', { name: 'Rename 1 Files' }));

    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Batch rename failed:', expect.any(Error));
    expect(screen.getByRole('heading', { name: 'Batch Rename' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename 1 Files' })).toBeEnabled();
  });

  it('closes from cancel, close button, and backdrop only while idle', async () => {
    const { user, props, container, unmount } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(container.firstElementChild as Element);

    expect(props.onClose).toHaveBeenCalledTimes(3);
    unmount();

    const applying = renderDialog({
      files: [file('draft.txt')],
      onApply: () => new Promise(() => {}),
    });
    const applyingQueries = within(applying.container);
    await applying.user.type(applyingQueries.getByPlaceholderText('Text to find...'), 'draft');
    await applying.user.type(applyingQueries.getByPlaceholderText('Replacement text...'), 'final');
    await applying.user.click(applyingQueries.getByRole('button', { name: 'Rename 1 Files' }));
    await applying.user.click(applying.container.firstElementChild as Element);

    const dialogs = applyingQueries.getAllByRole('heading', { name: 'Batch Rename' });
    expect(dialogs.length).toBeGreaterThan(0);
  });
});
