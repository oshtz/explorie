import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { ArchiveDialog } from './ArchiveDialog';

type ProgressEvent = {
  payload: {
    operationId: string;
    processedBytes: number;
    totalBytes: number;
    currentPath: string;
  };
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  progressHandler: undefined as ((event: ProgressEvent) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

function file(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: name,
    path: `/workspace/${name}`,
    name,
    size: 2048,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof ArchiveDialog>> = {}) {
  const props: React.ComponentProps<typeof ArchiveDialog> = {
    open: true,
    mode: 'compress',
    files: [file('report.txt')],
    currentPath: '/workspace',
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  };

  return {
    user: userEvent.setup(),
    props,
    ...render(<ArchiveDialog {...props} />),
  };
}

describe('ArchiveDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.unlisten.mockReset();
    mocks.progressHandler = undefined;
    mocks.listen.mockImplementation(
      async (_event: string, handler: (event: ProgressEvent) => void) => {
        mocks.progressHandler = handler;
        return mocks.unlisten;
      }
    );
    mocks.invoke.mockResolvedValue({
      output_path: '/workspace/report.zip',
      total_bytes: 2048,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render when closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('heading', { name: 'Create Archive' })).not.toBeInTheDocument();
  });

  it('builds a compress command from selected files and reports success', async () => {
    const { user, props } = renderDialog({
      files: [file('report.txt', { size: 2048 }), file('assets', { is_dir: true, size: 0 })],
    });

    expect(screen.getByRole('heading', { name: 'Create Archive' })).toBeVisible();
    expect(screen.getByText('2 items selected')).toBeVisible();
    expect(screen.getByText('report.txt')).toBeVisible();
    expect(screen.getByText('assets')).toBeVisible();

    await user.clear(screen.getByPlaceholderText('Enter archive name...'));
    await user.type(screen.getByPlaceholderText('Enter archive name...'), 'release:build');
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'tar.gz');
    await user.selectOptions(screen.getAllByRole('combobox')[1], 'best');

    const createButton = screen.getByRole('button', { name: /Create Archive/ });
    await user.click(createButton);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'compress_files',
        expect.objectContaining({
          paths: ['/workspace/report.txt', '/workspace/assets'],
          outputPath: '/workspace/release_build.tar.gz',
          format: 'tar.gz',
          compressionLevel: 'best',
        })
      )
    );

    const operationId = mocks.invoke.mock.calls[0][1].operationId as string;
    expect(operationId).toMatch(/^compress-/);
    expect(mocks.listen).toHaveBeenCalledWith('archive:compress-progress', expect.any(Function));
    mocks.progressHandler?.({
      payload: {
        operationId,
        processedBytes: 1024,
        totalBytes: 2048,
        currentPath: '/workspace/report.txt',
      },
    });

    expect(await screen.findByText(/Created \/workspace\/report\.zip/)).toBeVisible();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
  });

  it('shows compression errors and unlistens progress listeners', async () => {
    const { user } = renderDialog();
    mocks.invoke.mockRejectedValue(new Error('disk full'));

    await user.click(screen.getByRole('button', { name: /Create Archive/ }));

    expect(await screen.findByText(/Compression failed: Not enough disk space/)).toBeVisible();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Create Archive/ })).toBeEnabled();
  });

  it('loads archive contents, filters preview entries, and extracts', async () => {
    const archive = file('bundle.zip');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_archive') {
        return {
          format: 'zip',
          total_size: 4096,
          compressed_size: 1024,
          entry_count: 3,
          entries: [
            {
              name: 'src',
              path: 'src/',
              size: 0,
              compressed_size: 0,
              is_dir: true,
            },
            {
              name: 'readme.md',
              path: 'src/readme.md',
              size: 2048,
              compressed_size: 512,
              is_dir: false,
            },
            {
              name: 'logo.png',
              path: 'assets/logo.png',
              size: 2048,
              compressed_size: 512,
              is_dir: false,
            },
          ],
        };
      }
      if (command === 'extract_archive_cmd') {
        return {
          output_dir: '/workspace/output',
          total_bytes: 4096,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const { user, props } = renderDialog({
      mode: 'extract',
      files: [archive],
      currentPath: '/workspace/output',
    });

    expect(screen.getByRole('heading', { name: 'Extract Archive' })).toBeVisible();
    expect(await screen.findByText('3')).toBeVisible();
    expect(screen.getByText('4.0 KB')).toBeVisible();
    expect(screen.getByText('1.0 KB')).toBeVisible();
    expect(screen.getByText('src/readme.md')).toBeVisible();

    await user.type(screen.getByPlaceholderText('Search archive contents...'), 'logo');
    expect(screen.getByText('1 of 3 entries')).toBeVisible();
    expect(screen.getByText('assets/logo.png')).toBeVisible();
    expect(screen.queryByText('src/readme.md')).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText('Output directory...'));
    await user.type(screen.getByPlaceholderText('Output directory...'), '/workspace/output');
    await user.click(screen.getByRole('button', { name: /Extract/ }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('extract_archive_cmd', {
        archivePath: '/workspace/bundle.zip',
        outputDir: '/workspace/output',
      })
    );
    expect(await screen.findByText(/Extracted 4.0 KB to \/workspace\/output/)).toBeVisible();

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
  });

  it('reports archive listing and extraction errors', async () => {
    const archive = file('broken.zip');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_archive') throw new Error('not an archive');
      if (command === 'extract_archive_cmd') throw new Error('extract failed');
      throw new Error(`unexpected command ${command}`);
    });

    const { user } = renderDialog({
      mode: 'extract',
      files: [archive],
      currentPath: '/workspace/output',
    });

    expect(await screen.findByText(/Failed to read archive: Not an archive/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Extract/ }));
    expect(await screen.findByText(/Extraction failed: Extract failed/)).toBeVisible();
  });

  it('limits long file lists and disables processing without required inputs', async () => {
    const files = Array.from({ length: 7 }, (_, index) => file(`file-${index}.txt`));
    const { user } = renderDialog({ files });

    expect(screen.getByText('... and 2 more items')).toBeVisible();
    await user.clear(screen.getByPlaceholderText('Enter archive name...'));
    expect(screen.getByRole('button', { name: /Create Archive/ })).toBeDisabled();
  });

  it('closes from cancel, close, and idle backdrop but not while processing', async () => {
    const { user, props, container, unmount } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(container.firstElementChild as Element);

    expect(props.onClose).toHaveBeenCalledTimes(3);
    unmount();

    const processing = renderDialog({
      onSuccess: vi.fn(),
    });
    mocks.invoke.mockImplementation(() => new Promise(() => {}));
    await processing.user.click(screen.getByRole('button', { name: /Create Archive/ }));
    fireEvent.click(processing.container.firstElementChild as Element);

    expect(processing.props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Compressing/ })).toBeDisabled();
  });
});
