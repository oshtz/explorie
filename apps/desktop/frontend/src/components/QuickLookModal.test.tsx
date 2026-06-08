import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickLookModal } from './QuickLookModal';
import type { FileEntry } from '../store';

vi.mock('./FilePreviewer', () => ({
  FilePreviewer: ({ file, variant }: { file: FileEntry; variant?: string }) => (
    <div data-testid="file-previewer" data-variant={variant ?? ''}>
      Previewing {file.name ?? file.path}
    </div>
  ),
}));

function fileEntry(id: string, name: string): FileEntry {
  return {
    id,
    path: `/root/${name}`,
    name,
    size: 100,
    modified: 1,
    hidden: false,
    is_dir: false,
    custom: {},
  };
}

describe('QuickLookModal', () => {
  const files = [
    fileEntry('file-1', 'alpha.txt'),
    fileEntry('file-2', 'beta.txt'),
    fileEntry('file-3', 'gamma.txt'),
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders preview navigation and dispatches previous/next file actions', async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();

    render(
      <QuickLookModal file={files[1]} files={files} onClose={onClose} onNavigate={onNavigate} />
    );

    expect(screen.getByRole('heading', { name: 'beta.txt' })).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByTestId('file-previewer')).toHaveTextContent('Previewing beta.txt');
    expect(screen.getByTestId('file-previewer')).toHaveAttribute('data-variant', 'quicklook');

    fireEvent.click(screen.getByTitle('Previous file (Arrow Left)'));
    fireEvent.click(screen.getByTitle('Next file (Arrow Right)'));

    expect(onNavigate).toHaveBeenNthCalledWith(1, files[0]);
    expect(onNavigate).toHaveBeenNthCalledWith(2, files[2]);

    fireEvent.click(screen.getByTitle('Close (Escape)'));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows compact file details from the info toggle', async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();

    render(
      <QuickLookModal file={files[1]} files={files} onClose={onClose} onNavigate={onNavigate} />
    );

    expect(screen.getByText('100 Bytes')).toBeInTheDocument();
    expect(screen.queryByText('/root/beta.txt')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show file info' }));

    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.getByText('/root/beta.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide file info' })).toBeInTheDocument();
  });

  it('handles keyboard navigation, disabled edge navigation, and backdrop close', () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const { container } = render(
      <QuickLookModal file={files[0]} files={files} onClose={onClose} onNavigate={onNavigate} />
    );

    expect(screen.getByTitle('Previous file (Arrow Left)')).toBeDisabled();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenCalledWith(files[1]);

    fireEvent.click(container.firstElementChild as Element);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
