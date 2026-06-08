import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileSystemTest from './FileSystemTest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock('../utils/fs', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  listDirectory: mocks.listDirectory,
  fileExists: mocks.fileExists,
}));

describe('FileSystemTest', () => {
  beforeEach(() => {
    mocks.readFile.mockResolvedValue('hello from disk');
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.listDirectory.mockResolvedValue([
      { name: 'Documents', children: [] },
      { name: 'notes.txt' },
    ]);
    mocks.fileExists.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders controls and validates empty paths before calling filesystem helpers', async () => {
    const user = userEvent.setup();
    render(<FileSystemTest />);

    expect(screen.getByText('File System Test')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter file path')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter directory path')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Read File' }));
    expect(screen.getByText('Please enter a file path')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'List Directory' }));
    expect(screen.getByText('Please enter a directory path')).toBeInTheDocument();
    expect(mocks.fileExists).not.toHaveBeenCalled();
  });

  it('reads existing files and writes textarea content', async () => {
    const user = userEvent.setup();
    render(<FileSystemTest />);

    await user.type(screen.getByPlaceholderText('Enter file path'), '/tmp/example.txt');
    await user.click(screen.getByRole('button', { name: 'Read File' }));

    await waitFor(() => expect(mocks.fileExists).toHaveBeenCalledWith('/tmp/example.txt'));
    expect(mocks.readFile).toHaveBeenCalledWith('/tmp/example.txt');
    expect(
      screen.getByPlaceholderText('File content will appear here / Enter content to write')
    ).toHaveValue('hello from disk');
    expect(screen.getByText('File read successfully')).toBeInTheDocument();

    await user.clear(
      screen.getByPlaceholderText('File content will appear here / Enter content to write')
    );
    await user.type(
      screen.getByPlaceholderText('File content will appear here / Enter content to write'),
      'updated body'
    );
    await user.click(screen.getByRole('button', { name: 'Write File' }));

    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledWith('/tmp/example.txt', 'updated body')
    );
    expect(screen.getByText('File written successfully')).toBeInTheDocument();
  });

  it('shows missing-file and read-error messages', async () => {
    const user = userEvent.setup();
    render(<FileSystemTest />);

    await user.type(screen.getByPlaceholderText('Enter file path'), '/tmp/missing.txt');
    mocks.fileExists.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Read File' }));

    expect(await screen.findByText('File does not exist: /tmp/missing.txt')).toBeInTheDocument();
    expect(mocks.readFile).not.toHaveBeenCalled();

    mocks.fileExists.mockResolvedValueOnce(true);
    mocks.readFile.mockRejectedValueOnce(new Error('permission denied'));
    await user.click(screen.getByRole('button', { name: 'Read File' }));

    expect(await screen.findByText('Error reading file: permission denied')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('lists directories and labels directory/file entries', async () => {
    const user = userEvent.setup();
    render(<FileSystemTest />);

    await user.type(screen.getByPlaceholderText('Enter directory path'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'List Directory' }));

    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledWith('/tmp'));
    expect(screen.getByText('Documents (Directory)')).toBeInTheDocument();
    expect(screen.getByText('notes.txt (File)')).toBeInTheDocument();
    expect(screen.getByText('Directory read successfully')).toBeInTheDocument();
  });

  it('shows directory existence and listing errors', async () => {
    const user = userEvent.setup();
    render(<FileSystemTest />);

    await user.type(screen.getByPlaceholderText('Enter directory path'), '/tmp/missing');
    mocks.fileExists.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'List Directory' }));

    expect(await screen.findByText('Directory does not exist: /tmp/missing')).toBeInTheDocument();
    expect(mocks.listDirectory).not.toHaveBeenCalled();

    mocks.fileExists.mockResolvedValueOnce(true);
    mocks.listDirectory.mockRejectedValueOnce('not readable');
    await user.click(screen.getByRole('button', { name: 'List Directory' }));

    expect(await screen.findByText('Error reading directory: not readable')).toBeInTheDocument();
  });
});
