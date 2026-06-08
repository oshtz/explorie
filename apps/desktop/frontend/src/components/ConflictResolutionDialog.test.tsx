import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConflictInfo } from '../conflictResolutionStore';
import { ConflictResolutionDialog } from './ConflictResolutionDialog';

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

function createConflict(overrides: Partial<ConflictInfo> = {}): ConflictInfo {
  return {
    sourcePath: '/Users/test/source/report.pdf',
    sourceName: 'report.pdf',
    sourceSize: 2048,
    sourceModified: new Date('2026-06-03T08:00:00.000Z'),
    sourceIsDir: false,
    destPath: '/Users/test/dest/report.pdf',
    destName: 'report.pdf',
    destSize: 1024,
    destModified: new Date('2026-06-02T08:00:00.000Z'),
    destIsDir: false,
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ConflictResolutionDialog>> = {}
) {
  const onResolve = vi.fn();
  const onCancel = vi.fn();
  const props = {
    open: true,
    conflict: createConflict(),
    operationType: 'copy' as const,
    currentIndex: 2,
    totalConflicts: 3,
    onResolve,
    onCancel,
    ...overrides,
  };

  return {
    onResolve,
    onCancel,
    ...render(<ConflictResolutionDialog {...props} />),
  };
}

describe('ConflictResolutionDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render while closed or without conflict data', () => {
    const { container, rerender } = renderDialog({ open: false });
    expect(container).toBeEmptyDOMElement();

    rerender(
      <ConflictResolutionDialog
        open
        conflict={null}
        operationType="copy"
        onResolve={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders file conflict details and counter', () => {
    renderDialog();

    expect(screen.getByRole('alertdialog', { name: 'File Already Exists' })).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText(/A file named/)).toHaveTextContent(
      'A file named "report.pdf" already exists in the destination. What would you like to do?'
    );
    expect(screen.getByText('Source (copying from)')).toBeInTheDocument();
    expect(screen.getByText('Existing file')).toBeInTheDocument();
    expect(screen.getAllByText('report.pdf')).toHaveLength(2);
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('1 KB')).toBeInTheDocument();
    expect(screen.getByLabelText('Apply this action to all 3 conflicts')).not.toBeChecked();
  });

  it('resolves actions with and without apply-to-all', async () => {
    const user = userEvent.setup();
    const { onResolve } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onResolve).toHaveBeenCalledWith('skip', false);

    await user.click(screen.getByLabelText('Apply this action to all 3 conflicts'));
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onResolve).toHaveBeenLastCalledWith('replace', true);

    await user.click(screen.getByRole('button', { name: 'Keep Both' }));
    expect(onResolve).toHaveBeenLastCalledWith('keepBoth', true);
  });

  it('cancels from Escape, backdrop, and Cancel All', async () => {
    const user = userEvent.setup();
    const { onCancel, container } = renderDialog();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('alertdialog', { name: 'File Already Exists' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(container.firstElementChild as Element);
    expect(onCancel).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Cancel All' }));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it('renders folder move conflicts without apply-to-all controls', () => {
    renderDialog({
      operationType: 'move',
      totalConflicts: 1,
      currentIndex: 1,
      conflict: createConflict({
        sourcePath: '/Users/test/source/Assets',
        sourceName: 'Assets',
        sourceSize: undefined,
        sourceModified: undefined,
        sourceIsDir: true,
        destPath: '/Users/test/dest/Assets',
        destName: 'Assets',
        destSize: undefined,
        destModified: undefined,
        destIsDir: true,
      }),
    });

    expect(screen.getByRole('alertdialog', { name: 'Folder Already Exists' })).toBeInTheDocument();
    expect(screen.queryByText('1 of 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Apply this action/)).not.toBeInTheDocument();
    expect(screen.getByText('Source (moving from)')).toBeInTheDocument();
    expect(screen.getByText('Existing folder')).toBeInTheDocument();
    expect(screen.getAllByText('Folder')).toHaveLength(2);
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });
});
