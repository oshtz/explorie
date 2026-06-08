import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecureDeleteDialog } from './SecureDeleteDialog';
import type { FileEntry } from '../store';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getTrashPath: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('../utils/trash', () => ({
  getTrashPath: () => mocks.getTrashPath(),
  isTrashPath: (path: string, trashPath: string) =>
    path.replace(/\\/g, '/').toLowerCase().startsWith(trashPath.toLowerCase()),
}));

function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: overrides.id ?? 'file-1',
    path: overrides.path ?? '/root/report.txt',
    name: overrides.name ?? 'report.txt',
    size: overrides.size ?? 1024,
    modified: overrides.modified ?? 1,
    hidden: overrides.hidden ?? false,
    is_dir: overrides.is_dir ?? false,
    custom: overrides.custom ?? {},
  };
}

describe('SecureDeleteDialog', () => {
  beforeEach(() => {
    mocks.getTrashPath.mockResolvedValue('/trash');
    mocks.invoke.mockResolvedValue({ count: 3, size: 4096 });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render while closed', () => {
    const { container } = render(
      <SecureDeleteDialog open={false} files={[]} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes files and confirms trash or permanent delete choices', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onDontAskAgainChange = vi.fn();

    render(
      <SecureDeleteDialog
        open
        files={[fileEntry()]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        showDontAskAgain
        onDontAskAgainChange={onDontAskAgainChange}
      />
    );

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Delete Items')).toBeInTheDocument();
    expect(screen.getByText(/1 item/)).toBeInTheDocument();
    expect(screen.getByText('report.txt')).toBeInTheDocument();
    expect(screen.getAllByText('1 KB')).toHaveLength(2);

    await user.click(screen.getByRole('checkbox', { name: /don't ask again/i }));
    await user.click(screen.getByRole('button', { name: /move to trash/i }));
    await user.click(screen.getByRole('button', { name: /delete permanently/i }));

    expect(onDontAskAgainChange).toHaveBeenCalledWith(true);
    expect(onConfirm).toHaveBeenNthCalledWith(1, false);
    expect(onConfirm).toHaveBeenNthCalledWith(2, true);
  });

  it('loads non-empty folder info before enabling recursive delete actions', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const folder = fileEntry({
      id: 'folder-1',
      path: '/root/photos',
      name: 'photos',
      size: 0,
      is_dir: true,
    });

    render(<SecureDeleteDialog open files={[folder]} onConfirm={onConfirm} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: /move to trash/i })).toBeDisabled();
    expect(screen.getByText('(loading...)')).toBeInTheDocument();

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('get_dir_info', { path: '/root/photos' })
    );

    expect(await screen.findByText('(3 items)')).toBeInTheDocument();
    expect(screen.getByText('4 items (including folder contents)')).toBeInTheDocument();
    expect(screen.getByText('4 KB')).toBeInTheDocument();
    expect(screen.getByText(/non-empty folders will be deleted recursively/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('forces permanent delete messaging for items already in trash and handles dismissal', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const trashed = fileEntry({
      id: 'trash-file',
      path: '/trash/report.txt',
      name: 'report.txt',
    });

    render(<SecureDeleteDialog open files={[trashed]} onConfirm={onConfirm} onCancel={onCancel} />);

    expect(await screen.findByText('Permanently Delete')).toBeInTheDocument();
    expect(screen.getByText('In Trash')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move to trash/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(onConfirm).toHaveBeenCalledWith(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
