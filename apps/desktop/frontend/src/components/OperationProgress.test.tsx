import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationProgress } from './OperationProgress';
import type { FileOperation } from '../operationQueueStore';
import { useOperationQueueStore } from '../operationQueueStore';

const initialOperationState = useOperationQueueStore.getState();

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
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    estimatedTimeRemaining: overrides.estimatedTimeRemaining,
    speed: overrides.speed,
    error: overrides.error,
    failedItems: overrides.failedItems ?? [],
    conflictResolution: overrides.conflictResolution ?? 'ask',
    conflicts: overrides.conflicts ?? [],
    abortController: overrides.abortController,
  };
}

describe('OperationProgress', () => {
  beforeEach(() => {
    useOperationQueueStore.setState(
      {
        ...initialOperationState,
        operations: [],
        showProgressPanel: false,
        maxConcurrent: 2,
      },
      true
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render when the progress panel is closed or empty', () => {
    const { container } = render(<OperationProgress />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows running progress and dispatches pause, resume, cancel, and minimize actions', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({
      showProgressPanel: true,
      operations: [
        operation({
          currentItem: 'report.txt',
          destinationPath: '/backup',
          speed: 1024,
          estimatedTimeRemaining: 65_000,
        }),
      ],
    });

    render(<OperationProgress />);

    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('1 KB/s')).toBeInTheDocument();
    expect(screen.getByText('1m 5s left')).toBeInTheDocument();
    expect(screen.getByText('report.txt')).toBeInTheDocument();

    await user.click(screen.getByTitle('Pause'));
    expect(useOperationQueueStore.getState().operations[0].status).toBe('paused');

    await user.click(screen.getByTitle('Resume'));
    expect(useOperationQueueStore.getState().operations[0].status).toBe('running');

    await user.click(screen.getByTitle('Minimize'));
    expect(screen.getByText('1 operation in progress')).toBeInTheDocument();

    await user.click(screen.getByText('1 operation in progress'));
    await user.click(screen.getByTitle('Cancel'));
    expect(useOperationQueueStore.getState().operations[0].status).toBe('cancelled');
  });

  it('shows failed and completed operations with retry, dismiss, clear, and close actions', async () => {
    const user = userEvent.setup();
    useOperationQueueStore.setState({
      showProgressPanel: true,
      operations: [
        operation({
          id: 'failed-op',
          status: 'failed',
          type: 'delete',
          totalBytes: 0,
          processedBytes: 0,
          totalItems: 1,
          processedItems: 0,
          error: 'Permission denied',
        }),
        operation({
          id: 'done-op',
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

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('4 KB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual(['done-op']);

    act(() => {
      useOperationQueueStore.setState({
        operations: [
          operation({ id: 'failed-op', status: 'failed', error: 'Still blocked' }),
          operation({ id: 'done-op', status: 'completed', processedBytes: 4096 }),
        ],
      });
    });

    await user.click(screen.getByTitle('Retry'));
    expect(useOperationQueueStore.getState().operations[0].status).toBe('running');

    await user.click(screen.getByTitle('Clear completed'));
    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual(['failed-op']);

    act(() => {
      useOperationQueueStore.setState({
        showProgressPanel: true,
        operations: [operation({ id: 'pending-op', status: 'pending' })],
      });
    });

    await user.click(screen.getByTitle('Close'));
    expect(useOperationQueueStore.getState().showProgressPanel).toBe(false);
  });
});
