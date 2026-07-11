import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardShortcutsOverlay } from './KeyboardShortcutsOverlay';

function renderOverlay(
  overrides: Partial<React.ComponentProps<typeof KeyboardShortcutsOverlay>> = {}
) {
  const onClose = vi.fn();
  const props = {
    open: true,
    onClose,
    ...overrides,
  };

  return {
    props,
    onClose,
    ...render(<KeyboardShortcutsOverlay {...props} />),
  };
}

describe('KeyboardShortcutsOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not render while closed', () => {
    const { container } = renderOverlay({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders shortcut categories and focuses search when opened', async () => {
    renderOverlay();

    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('File Operations')).toBeInTheDocument();
    expect(screen.getByText('Search & Commands')).toBeInTheDocument();
    expect(screen.getByText('Ctrl + Shift + P')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View full documentation' })).toHaveAttribute(
      'href',
      'https://github.com/explorie/explorie#keyboard-shortcuts'
    );

    await waitFor(() => expect(screen.getByPlaceholderText('Search shortcuts...')).toHaveFocus());
  });

  it('filters shortcuts by key or description and shows an empty state', async () => {
    const user = userEvent.setup();
    renderOverlay();

    const search = screen.getByPlaceholderText('Search shortcuts...');
    await user.type(search, 'rename');

    expect(screen.getByText('Rename selected item')).toBeInTheDocument();
    expect(screen.getByText('F2')).toBeInTheDocument();
    expect(screen.queryByText('Go back')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'nothing matches this');

    expect(screen.getByText('No shortcuts found')).toBeInTheDocument();
    expect(screen.queryByText('Navigation')).not.toBeInTheDocument();
  });

  it('closes from the close button and backdrop only when the backdrop is targeted', async () => {
    const user = userEvent.setup();
    const { onClose, container } = renderOverlay();

    fireEvent.click(screen.getByRole('dialog', { name: 'Keyboard shortcuts' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without intercepting unrelated keys', () => {
    const { onClose } = renderOverlay();

    fireEvent.keyDown(screen.getByPlaceholderText('Search shortcuts...'), { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByPlaceholderText('Search shortcuts...'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
