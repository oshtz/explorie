import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoToFolderDialog } from './GoToFolderDialog';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

function renderDialog(overrides: Partial<React.ComponentProps<typeof GoToFolderDialog>> = {}) {
  const props = {
    open: true,
    currentPath: '/root',
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };

  return {
    props,
    ...render(<GoToFolderDialog {...props} />),
  };
}

describe('GoToFolderDialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.invoke.mockImplementation(
      async (command: string, args?: { path?: string; name?: string }) => {
        if (command === 'get_home_dir') {
          return '/home/test';
        }
        if (command === 'list_files') {
          if (args?.path?.includes('missing')) {
            throw new Error('No such file or directory');
          }
          if (args?.path === '/root') {
            return [
              { path: '/root/Documents', name: 'Documents', is_dir: true },
              { path: '/root/Downloads', name: 'Downloads', is_dir: true },
              { path: '/root/doc.txt', name: 'doc.txt', is_dir: false },
            ];
          }
          return [];
        }
        return null;
      }
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render while closed', () => {
    const { container } = renderDialog({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('expands the home shorthand, validates the folder, records it as recent, and navigates', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const input = screen.getByPlaceholderText('Enter folder path...');

    await user.clear(input);
    await user.type(input, '~/projects');
    await user.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(props.onNavigate).toHaveBeenCalledWith('/home/test/projects'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem('explorie:goToFolderRecent') ?? '[]')).toEqual([
      '/home/test/projects',
    ]);
  });

  it('shows autocomplete suggestions and applies the clicked folder path', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByPlaceholderText('Enter folder path...');

    await user.clear(input);
    await user.type(input, 'Doc');

    expect(await screen.findByText('/root/Documents')).toBeInTheDocument();
    expect(screen.queryByText('/root/doc.txt')).not.toBeInTheDocument();

    await user.click(screen.getByText('/root/Documents'));
    expect(input).toHaveValue('/root/Documents');
  });

  it('supports recent suggestions from the keyboard', async () => {
    window.localStorage.setItem(
      'explorie:goToFolderRecent',
      JSON.stringify(['/root/Recent Project'])
    );
    renderDialog();
    const input = screen.getByPlaceholderText('Enter folder path...');

    await userEvent.clear(input);
    fireEvent.focus(input);
    expect(await screen.findByText('/root/Recent Project')).toBeInTheDocument();
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Folder suggestions' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'go-to-folder-suggestion-0');
    expect(screen.getByRole('option', { name: /Recent Project/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/root/Recent Project');
  });

  it('shows validation errors and closes from backdrop or Escape', async () => {
    const user = userEvent.setup();
    const { props, container } = renderDialog();
    const input = screen.getByPlaceholderText('Enter folder path...');

    await user.clear(input);
    await user.type(input, '/root/missing');
    await user.click(screen.getByRole('button', { name: 'Go' }));

    expect(await screen.findByText('Path does not exist')).toBeInTheDocument();

    fireEvent.click(container.firstElementChild as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
