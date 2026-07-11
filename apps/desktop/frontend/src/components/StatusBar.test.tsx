import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import type { FileOperation } from '../operationQueueStore';
import { useOperationQueueStore } from '../operationQueueStore';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

const initialFileState = useFileStore.getState();
const initialOperationState = useOperationQueueStore.getState();

function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: overrides.id ?? 'entry-1',
    path: overrides.path ?? '/root/report.txt',
    name: overrides.name ?? 'report.txt',
    size: overrides.size ?? 1024,
    modified: overrides.modified ?? 1,
    hidden: overrides.hidden ?? false,
    is_dir: overrides.is_dir ?? false,
    custom: overrides.custom ?? {},
  };
}

function operation(overrides: Partial<FileOperation> = {}): FileOperation {
  return {
    id: overrides.id ?? 'op-1',
    type: overrides.type ?? 'copy',
    status: overrides.status ?? 'running',
    items: overrides.items ?? [
      {
        sourcePath: '/root/report.txt',
        destPath: '/backup/report.txt',
        size: 200,
        name: 'report.txt',
        isDir: false,
      },
    ],
    destinationPath: overrides.destinationPath,
    totalBytes: overrides.totalBytes ?? 200,
    processedBytes: overrides.processedBytes ?? 50,
    totalItems: overrides.totalItems ?? 2,
    processedItems: overrides.processedItems ?? 1,
    currentItem: overrides.currentItem,
    startedAt: overrides.startedAt ?? Date.now(),
    completedAt: overrides.completedAt,
    error: overrides.error,
    conflictResolution: overrides.conflictResolution ?? 'ask',
  };
}

describe('StatusBar', () => {
  beforeEach(() => {
    mocks.invoke.mockResolvedValue({
      mount_point: '/root',
      total_space: 10 * 1024 ** 3,
      available_space: 5 * 1024 ** 3,
      name: 'Local Disk',
    });
    useFileStore.setState(
      {
        ...initialFileState,
        viewMode: 'list',
        filterMode: 'all',
        searchQuery: '',
        showHidden: false,
      },
      true
    );
    useOperationQueueStore.setState(
      {
        ...initialOperationState,
        operations: [],
        showProgressPanel: false,
      },
      true
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders folder stats, selected file details, filter status, disk info, and view mode', async () => {
    render(
      <StatusBar
        currentPath="/root"
        files={[
          fileEntry({ id: 'folder', path: '/root/docs', name: 'docs', is_dir: true, size: 0 }),
          fileEntry({ id: 'visible', size: 1024 }),
          fileEntry({ id: 'hidden', path: '/root/.env', name: '.env', size: 2048, hidden: true }),
        ]}
        selectedFile={fileEntry({ name: 'report.txt', size: 1024 })}
      />
    );

    expect(screen.getByText('1 folder, 2 files')).toBeInTheDocument();
    expect(screen.getByText('3 KB')).toBeInTheDocument();
    expect(screen.getByText(/1 hidden/)).toBeInTheDocument();
    expect(screen.getByText('Selected: report.txt (1 KB)')).toBeInTheDocument();
    expect(screen.getByText('List view')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('5 GB free of 10 GB')).toBeInTheDocument());
    expect(mocks.invoke).toHaveBeenCalledWith('get_disk_info', { path: '/root' });
  });

  it('keeps counts and view labels informational', () => {
    render(<StatusBar currentPath="/root" files={[fileEntry()]} selectedFile={null} />);

    expect(screen.getByText('1 file').closest('button')).toBeNull();
    expect(screen.getByText('List view').closest('button')).toBeNull();
  });

  it('shows operation progress and opens the progress panel', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({ operations: [operation()] });

    render(<StatusBar currentPath="/root" files={[]} selectedFile={null} />);

    const operationStatus = screen.getByText('Copying 25%');
    expect(operationStatus.closest('button')).toHaveAttribute('title', 'Copying 25% (1/2 items)');

    await user.click(operationStatus);
    expect(useOperationQueueStore.getState().showProgressPanel).toBe(true);
  });
});
