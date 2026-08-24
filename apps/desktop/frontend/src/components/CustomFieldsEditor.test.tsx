import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { CustomFieldsEditor } from './CustomFieldsEditor';

const mocks = vi.hoisted(() => ({
  updateCustomFields: vi.fn(),
  reportError: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../utils/fs', () => ({
  updateCustomFields: mocks.updateCustomFields,
}));

vi.mock('../utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('./Toast', () => ({
  useToast: () => ({ show: mocks.showToast }),
}));

function createFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'file-1',
    path: '/Users/test/file.txt',
    name: 'file.txt',
    size: 128,
    modified: 1,
    is_dir: false,
    custom: {
      status: 'Todo',
      tags: ['review', 'client'],
    },
    ...overrides,
  };
}

function getFieldRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest('div');
  if (!row) {
    throw new Error(`Could not find row for ${label}`);
  }
  return row;
}

describe('CustomFieldsEditor', () => {
  beforeEach(() => {
    mocks.updateCustomFields.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders existing fields and removes a scalar field', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<CustomFieldsEditor file={createFile()} onUpdate={onUpdate} />);

    expect(screen.getByText('Custom Fields')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
    expect(screen.getByText('client')).toBeInTheDocument();

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        tags: ['review', 'client'],
      })
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ custom: { tags: ['review', 'client'] } })
    );
  });

  it('adds a new scalar field from suggestions', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<CustomFieldsEditor file={createFile({ custom: {} })} onUpdate={onUpdate} />);

    const fieldName = screen.getByPlaceholderText('Field name');

    await user.click(fieldName);
    await user.type(fieldName, 'prio');
    await user.click(screen.getByText('priority'));

    await user.selectOptions(screen.getByLabelText('priority value'), 'High');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        priority: 'High',
      })
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ custom: { priority: 'High' } })
    );
  });

  it('adds tags as arrays and removes individual tags', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <CustomFieldsEditor file={createFile({ custom: { tags: ['review'] } })} onUpdate={onUpdate} />
    );

    await user.click(screen.getByText('+ Add'));
    const tagEditInput = within(getFieldRow('tags')).getByDisplayValue('review');
    await user.clear(tagEditInput);
    await user.type(tagEditInput, 'client');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        tags: ['review', 'client'],
      })
    );

    mocks.updateCustomFields.mockClear();
    await user.click(within(getFieldRow('tags')).getAllByRole('button')[0]);

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        tags: ['client'],
      })
    );
  });

  it('edits existing fields with value suggestions and supports cancel', async () => {
    const user = userEvent.setup();
    render(<CustomFieldsEditor file={createFile({ custom: { status: 'Todo' } })} />);

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Edit' }));
    const statusEditInput = within(getFieldRow('status')).getByLabelText('status value');
    expect(statusEditInput).toHaveValue('Todo');

    await user.selectOptions(statusEditInput, 'Done');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        status: 'Done',
      })
    );

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Edit' }));
    const secondEditInput = within(getFieldRow('status')).getByLabelText('status value');
    await user.selectOptions(secondEditInput, 'Blocked');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(mocks.updateCustomFields).toHaveBeenCalledTimes(1);
  });

  it('exposes date, url and closed enum controls', async () => {
    const user = userEvent.setup();
    render(
      <CustomFieldsEditor
        file={createFile({
          custom: {
            dueDate: '2024-01-15',
            url: 'https://example.com',
            status: 'Todo',
          },
        })}
      />
    );

    expect(within(getFieldRow('dueDate')).getByText('date type')).toBeInTheDocument();
    expect(within(getFieldRow('url')).getByText('url type')).toBeInTheDocument();
    expect(within(getFieldRow('status')).getByText('enum type')).toBeInTheDocument();

    await user.click(within(getFieldRow('dueDate')).getByRole('button', { name: 'Edit' }));
    expect(within(getFieldRow('dueDate')).getByLabelText('dueDate value')).toHaveAttribute(
      'type',
      'date'
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(within(getFieldRow('url')).getByRole('button', { name: 'Edit' }));
    expect(within(getFieldRow('url')).getByLabelText('url value')).toHaveAttribute('type', 'url');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Edit' }));
    const statusSelect = within(getFieldRow('status')).getByLabelText('status value');
    expect(statusSelect.tagName).toBe('SELECT');
    expect(
      Array.from((statusSelect as HTMLSelectElement).options).map((option) => option.value)
    ).toEqual(['', 'Todo', 'In Progress', 'Done', 'Blocked', 'Pending Review']);
  });

  it('reports failed saves and rolls optimistic changes back', async () => {
    const user = userEvent.setup();
    const error = new Error('metadata denied');
    mocks.updateCustomFields.mockRejectedValueOnce(error);
    render(<CustomFieldsEditor file={createFile({ custom: { status: 'Todo' } })} />);

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.reportError).toHaveBeenCalledWith('Failed to remove field "status"', error, {
        toast: mocks.showToast,
      })
    );
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });
});
