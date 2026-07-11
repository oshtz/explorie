import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { OperationProgress } from './OperationProgress';
import type { FileOperation } from '../operationQueueStore';
import { useOperationQueueStore } from '../operationQueueStore';

function operation(overrides: Partial<FileOperation> = {}): FileOperation {
  return {
    id: 'job-1',
    type: 'copy',
    status: 'running',
    items: [
      {
        sourcePath: '/root/report.txt',
        destPath: '/backup/report.txt',
        size: 200,
        name: 'report.txt',
        isDir: false,
      },
    ],
    destinationPath: '/backup',
    totalBytes: 200,
    processedBytes: 50,
    totalItems: 2,
    processedItems: 1,
    currentItem: 'report.txt',
    startedAt: Date.now(),
    conflictResolution: 'ask',
    ...overrides,
  };
}

describe('OperationProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(true);
    useOperationQueueStore.setState({ operations: [], showProgressPanel: false });
  });

  afterEach(cleanup);

  it('does not render when the progress panel is closed or empty', () => {
    const { container } = render(<OperationProgress />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows native progress and delegates cancellation', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({ showProgressPanel: true, operations: [operation()] });
    render(<OperationProgress />);

    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('report.txt')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'File operations' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close operations' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Minimize operations' }));
    await user.click(screen.getByRole('button', { name: /expand operations: 1 in progress/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel copy operation' }));
    expect(invoke).toHaveBeenCalledWith('cancel_file_operation', { jobId: 'job-1' });
  });

  it('shows terminal operations and supports dismiss and close', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({
      showProgressPanel: true,
      operations: [
        operation({ id: 'failed', status: 'failed', type: 'delete', error: 'Denied' }),
        operation({ id: 'cancelled', status: 'cancelled', processedBytes: 20 }),
        operation({
          id: 'done',
          status: 'completed',
          type: 'move',
          processedBytes: 4096,
          totalBytes: 4096,
          totalItems: 1,
          processedItems: 1,
        }),
      ],
    });
    render(<OperationProgress />);

    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
    expect(screen.getAllByText('Cancelled')).toHaveLength(2);
    expect(screen.getByText('4 KB')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(useOperationQueueStore.getState().operations.map((item) => item.id)).toEqual([
      'cancelled',
      'done',
    ]);
    await user.click(screen.getByRole('button', { name: 'Close operations' }));
    expect(useOperationQueueStore.getState().showProgressPanel).toBe(false);
  });

  it('clears completed operations', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({
      showProgressPanel: true,
      operations: [operation({ status: 'completed', processedBytes: 200 })],
    });
    render(<OperationProgress />);

    await user.click(screen.getByRole('button', { name: 'Clear finished operations' }));
    expect(useOperationQueueStore.getState().operations).toEqual([]);
  });

  it('clamps invalid progress to the accessible range', () => {
    useOperationQueueStore.setState({
      showProgressPanel: true,
      operations: [operation({ processedBytes: 500, totalBytes: 200 })],
    });
    render(<OperationProgress />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
