import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { CustomFieldsEditor } from './CustomFieldsEditor';

const mocks = vi.hoisted(() => ({
  getCustomFieldsSchema: vi.fn(),
  updateCustomFields: vi.fn(),
  reportError: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../utils/fs', () => ({
  getCustomFieldsSchema: mocks.getCustomFieldsSchema,
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
    mocks.getCustomFieldsSchema.mockResolvedValue(null);
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
    const fieldValue = screen.getByPlaceholderText('Value');

    await user.click(fieldName);
    await user.type(fieldName, 'prio');
    await user.click(screen.getByText('priority'));

    await user.click(fieldValue);
    await user.click(screen.getByText('High'));
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
    const statusEditInput = within(getFieldRow('status')).getByDisplayValue('Todo');
    expect(statusEditInput).toBeInTheDocument();

    await user.clear(statusEditInput);
    await user.type(statusEditInput, 'Done');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        status: 'Done',
      })
    );

    await user.click(within(getFieldRow('status')).getByRole('button', { name: 'Edit' }));
    const secondEditInput = within(getFieldRow('status')).getByDisplayValue('Done');
    await user.clear(secondEditInput);
    await user.type(secondEditInput, 'Blocked');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(mocks.updateCustomFields).toHaveBeenCalledTimes(1);
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
    expect(
      screen
        .getAllByRole('alert')
        .some((element) => element.textContent?.includes('metadata denied'))
    ).toBe(true);
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  it('renders schema-aware number input and persists a number', async () => {
    const user = userEvent.setup();
    render(
      <CustomFieldsEditor
        file={createFile({ custom: {} })}
        schema={{ fields: { count: { type: 'number' } } }}
      />
    );

    await user.type(screen.getByPlaceholderText('Field name'), 'count');
    const value = screen.getByPlaceholderText('Value');
    expect(value).toHaveAttribute('type', 'number');
    await user.type(value, '7');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        count: 7,
      })
    );
  });

  it('renders schema-aware boolean input and persists a boolean', async () => {
    const user = userEvent.setup();
    render(
      <CustomFieldsEditor
        file={createFile({ custom: {} })}
        schema={{ fields: { enabled: { type: 'boolean' } } }}
      />
    );

    await user.type(screen.getByPlaceholderText('Field name'), 'enabled');
    const value = screen.getByRole('combobox');
    await user.selectOptions(value, 'true');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    await waitFor(() =>
      expect(mocks.updateCustomFields).toHaveBeenCalledWith('/Users/test', 'file.txt', {
        enabled: true,
      })
    );
  });

  it('reports typed validation errors inline without writing', async () => {
    const user = userEvent.setup();
    render(
      <CustomFieldsEditor
        file={createFile({ custom: {} })}
        schema={{ fields: { website: { type: 'url' } } }}
      />
    );

    await user.type(screen.getByPlaceholderText('Field name'), 'website');
    await user.type(screen.getByPlaceholderText('Value'), 'https://example.com:bad');
    await user.click(screen.getByRole('button', { name: 'Add Field' }));

    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('website: Expected url');
    expect(mocks.updateCustomFields).not.toHaveBeenCalled();
  });
});
