import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { BatchCustomFieldsDialog } from './BatchCustomFieldsDialog';

const mocks = vi.hoisted(() => ({
  getCustomFieldsSchema: vi.fn(),
  updateCustomFieldsBatch: vi.fn(),
}));

vi.mock('../utils/fs', () => ({
  getCustomFieldsSchema: mocks.getCustomFieldsSchema,
  updateCustomFieldsBatch: mocks.updateCustomFieldsBatch,
}));

function file(path: string, custom: FileEntry['custom'] = {}): FileEntry {
  return {
    id: path,
    path,
    name: path.split('/').pop(),
    size: 1,
    modified: 1,
    is_dir: false,
    custom,
  };
}

describe('BatchCustomFieldsDialog', () => {
  beforeEach(() => {
    mocks.getCustomFieldsSchema.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('writes one update per directory and preserves existing fields', async () => {
    const user = userEvent.setup();
    render(
      <BatchCustomFieldsDialog
        files={[file('/docs/one.txt', { status: 'todo' }), file('/docs/two.txt')]}
        onClose={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Field name'), 'reviewed');
    await user.type(screen.getByLabelText('Value'), 'yes');
    await user.click(screen.getByRole('button', { name: 'Apply to Selected' }));

    await waitFor(() => expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledTimes(1));
    expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledWith('/docs', {
      'one.txt': { status: 'todo', reviewed: 'yes' },
      'two.txt': { reviewed: 'yes' },
    });
  });

  it('writes one native batch call for each selected directory', async () => {
    const user = userEvent.setup();
    render(
      <BatchCustomFieldsDialog
        files={[file('/docs/one.txt'), file('/other/two.txt')]}
        onClose={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Field name'), 'reviewed');
    await user.type(screen.getByLabelText('Value'), 'yes');
    await user.click(screen.getByRole('button', { name: 'Apply to Selected' }));

    await waitFor(() => expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledTimes(2));
    expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledWith('/docs', {
      'one.txt': { reviewed: 'yes' },
    });
    expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledWith('/other', {
      'two.txt': { reviewed: 'yes' },
    });
  });

  it('shows a native validation reason and keeps the dialog open', async () => {
    const user = userEvent.setup();
    mocks.updateCustomFieldsBatch.mockRejectedValueOnce(new Error('expected date'));
    render(<BatchCustomFieldsDialog files={[file('/docs/one.txt')]} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('Field name'), 'dueDate');
    await user.type(screen.getByLabelText('Value'), 'not-a-date');
    await user.click(screen.getByRole('button', { name: 'Apply to Selected' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('expected date');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('uses the declared number type and writes a number', async () => {
    const user = userEvent.setup();
    render(
      <BatchCustomFieldsDialog
        files={[file('/docs/one.txt')]}
        schema={{ fields: { rating: { type: 'number' } } }}
        onClose={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Field name'), 'rating');
    const value = screen.getByLabelText('Value');
    expect(value).toHaveAttribute('type', 'number');
    await user.type(value, '4.5');
    await user.click(screen.getByRole('button', { name: 'Apply to Selected' }));

    await waitFor(() => expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledTimes(1));
    expect(mocks.updateCustomFieldsBatch).toHaveBeenCalledWith('/docs', {
      'one.txt': { rating: 4.5 },
    });
  });

  it('reports schema violations before issuing a batch write', async () => {
    const user = userEvent.setup();
    render(
      <BatchCustomFieldsDialog
        files={[file('/docs/one.txt')]}
        schema={{ fields: { website: { type: 'url' } } }}
        onClose={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText('Field name'), 'website');
    await user.type(screen.getByLabelText('Value'), 'https://example.com:bad');
    await user.click(screen.getByRole('button', { name: 'Apply to Selected' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('one.txt.website: Expected url');
    expect(mocks.updateCustomFieldsBatch).not.toHaveBeenCalled();
  });
});
