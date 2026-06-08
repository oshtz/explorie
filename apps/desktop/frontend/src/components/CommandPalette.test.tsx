import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type Command } from './CommandPalette';

const RECENTS_STORAGE_KEY = 'explorie:recentCommands';

function createCommands() {
  return [
    {
      id: 'go-home',
      name: 'Go Home',
      shortcut: 'Ctrl+H',
      category: 'navigation',
      action: vi.fn(),
    },
    {
      id: 'new-folder',
      name: 'New Folder',
      shortcut: 'Ctrl+Shift+N',
      category: 'file',
      action: vi.fn(),
    },
    {
      id: 'switch-grid',
      name: 'Switch to Grid',
      category: 'view',
      action: vi.fn(),
    },
  ] satisfies Command[];
}

function renderPalette(commands = createCommands(), onClose = vi.fn()) {
  render(<CommandPalette open onClose={onClose} commands={commands} />);
  return { commands, onClose };
}

describe('CommandPalette', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('filters commands with fuzzy search and shows empty results', async () => {
    const user = userEvent.setup();
    renderPalette();

    const input = screen.getByPlaceholderText('Type a command or search...');
    await user.type(input, 'grid');

    expect(screen.getByText('Switch to Grid')).toBeInTheDocument();
    expect(screen.queryByText('Go Home')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'zzzz');

    expect(screen.getByText('No commands found')).toBeInTheDocument();
  });

  it('executes clicked commands and stores recent command ids', async () => {
    const user = userEvent.setup();
    const { commands, onClose } = renderPalette();

    await user.click(screen.getByText('New Folder'));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(commands[1].action).toHaveBeenCalledTimes(1));
    expect(JSON.parse(window.localStorage.getItem(RECENTS_STORAGE_KEY) ?? '[]')).toEqual([
      'new-folder',
    ]);
  });

  it('supports keyboard selection and renders stored recent commands', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(['switch-grid']));
    const { commands } = renderPalette();

    expect(screen.getByText('Recently Used')).toBeInTheDocument();
    expect(screen.getAllByText('Switch to Grid')).toHaveLength(2);

    await user.click(screen.getByPlaceholderText('Type a command or search...'));
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(commands[0].action).toHaveBeenCalledTimes(1));
  });
});
