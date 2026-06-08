import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Breadcrumbs } from './Breadcrumbs';

vi.mock('../utils/path', async () => {
  const actual = await vi.importActual<typeof import('../utils/path')>('../utils/path');
  return {
    ...actual,
    buildPathStack: (path: string) => (path === '__empty__' ? [] : actual.buildPathStack(path)),
  };
});

describe('Breadcrumbs', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders path segments and navigates only to non-current segments', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Breadcrumbs path="/Users/alice/projects" onNavigate={onNavigate} />);

    expect(screen.getByTitle('/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Users' })).toHaveAttribute('title', '/Users');
    expect(screen.getByRole('button', { name: 'alice' })).toHaveAttribute('title', '/Users/alice');
    expect(screen.getByRole('button', { name: 'projects' })).toHaveAttribute(
      'title',
      '/Users/alice/projects'
    );

    await user.click(screen.getByRole('button', { name: 'Users' }));
    await user.click(screen.getByRole('button', { name: 'projects' }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/Users');
  });

  it('enters path edit mode from the background and submits trimmed paths', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Breadcrumbs path="/Users/alice/projects" onNavigate={onNavigate} />);

    await user.click(screen.getByTitle('Click to edit path'));
    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('/Users/alice/projects');

    await user.clear(input);
    await user.type(input, '  /tmp/explorie  ');
    await user.keyboard('{Enter}');

    expect(onNavigate).toHaveBeenCalledWith('/tmp/explorie');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('cancels edits with Escape and exits edit mode on blur', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Breadcrumbs path="/Users/alice/projects" onNavigate={onNavigate} />);

    await user.click(screen.getByTitle('Click to edit path'));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '/tmp/ignored');
    await user.keyboard('{Escape}');

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(screen.getByTitle('Click to edit path'));
    expect(screen.getByRole('textbox')).toHaveValue('/Users/alice/projects');

    await user.tab();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('uses the latest external path when entering edit mode', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerender } = render(<Breadcrumbs path="/first/path" onNavigate={onNavigate} />);

    rerender(<Breadcrumbs path="/second/path" onNavigate={onNavigate} />);

    await user.click(screen.getByTitle('Click to edit path'));

    expect(screen.getByRole('textbox')).toHaveValue('/second/path');
  });

  it('shows an empty-path placeholder when the path stack is empty', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();

    render(<Breadcrumbs path="__empty__" onNavigate={onNavigate} />);

    const placeholder = screen.getByText('No path selected');
    expect(placeholder).toBeInTheDocument();

    const container = placeholder.closest('div');
    expect(container).not.toBeNull();
    await user.click(container as HTMLDivElement);

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('__empty__');
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
