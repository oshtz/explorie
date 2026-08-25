import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { LinkBadge } from './LinkBadge';

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: '/workspace/link',
    path: '/workspace/link',
    name: 'link',
    size: 1,
    modified: 0,
    is_dir: false,
    custom: {},
    ...overrides,
  };
}

describe('LinkBadge', () => {
  afterEach(() => cleanup());

  it('renders a symbolic-link badge with its resolved target', () => {
    render(<LinkBadge file={file({ link_target: '../report.txt', is_symlink: true })} />);

    expect(screen.getByRole('img', { name: 'Symbolic link' })).toBeInTheDocument();
    expect(screen.getByText('/report.txt')).toBeInTheDocument();
    expect(screen.getByLabelText('Target: /report.txt')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Symbolic link' })).toHaveAttribute(
      'title',
      'Symbolic link → /report.txt'
    );
  });

  it('labels junctions and degrades when the target is unavailable', () => {
    const { rerender } = render(
      <LinkBadge
        file={file({ path: 'C:/workspace/link', is_junction: true, link_target: 'C:/data' })}
      />
    );

    expect(screen.getByRole('img', { name: 'Junction' })).toBeInTheDocument();
    expect(screen.getByText('C:/data')).toBeInTheDocument();

    rerender(<LinkBadge file={file({ is_symlink: true })} />);
    expect(screen.getByText('target unavailable')).toBeInTheDocument();
  });

  it('renders nothing for ordinary files', () => {
    const { container } = render(<LinkBadge file={file()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
