import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS, type ShortcutMap } from '../utils/shortcuts';
import { KeyboardShortcutSettings } from './KeyboardShortcutSettings';

const mocks = vi.hoisted(() => {
  const state = {
    shortcuts: {} as ShortcutMap,
    setShortcut: vi.fn(),
    resetShortcuts: vi.fn(),
  };
  const useFileStore = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state;
  return { state, useFileStore };
});

vi.mock('../store', () => ({
  useFileStore: mocks.useFileStore,
}));

describe('KeyboardShortcutSettings', () => {
  beforeEach(() => {
    mocks.state.shortcuts = { ...DEFAULT_SHORTCUTS };
    mocks.state.setShortcut.mockReset();
    mocks.state.resetShortcuts.mockReset();
    mocks.state.setShortcut.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('captures a new binding and persists through the store setter', async () => {
    const user = userEvent.setup();
    const onStatus = vi.fn();
    render(<KeyboardShortcutSettings onStatus={onStatus} />);

    await user.click(screen.getByRole('button', { name: 'Change shortcut for New tab' }));
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');

    expect(mocks.state.setShortcut).toHaveBeenCalledWith('tab-new', 'Mod+Alt+K');
    expect(onStatus).toHaveBeenLastCalledWith('Shortcut updated: New tab → Ctrl+Alt+K');
  });

  it('warns and refuses a key already assigned to another action', async () => {
    const user = userEvent.setup();
    mocks.state.shortcuts = { ...DEFAULT_SHORTCUTS, 'tab-close': 'Mod+Alt+K' };
    const onStatus = vi.fn();
    render(<KeyboardShortcutSettings onStatus={onStatus} />);

    await user.click(screen.getByRole('button', { name: 'Change shortcut for New tab' }));
    await user.keyboard('{Control>}{Alt>}k{/Alt}{/Control}');

    expect(mocks.state.setShortcut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ctrl+Alt+K is already assigned to Close current tab'
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      'Shortcut conflict: Ctrl+Alt+K is already assigned to Close current tab'
    );
  });

  it('warns and refuses a browser-reserved chord', async () => {
    const user = userEvent.setup();
    const onStatus = vi.fn();
    render(<KeyboardShortcutSettings onStatus={onStatus} />);

    await user.click(screen.getByRole('button', { name: 'Change shortcut for New tab' }));
    await user.keyboard('{Control>}l{/Control}');

    expect(mocks.state.setShortcut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Ctrl+L is reserved by the browser or operating system'
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      'Shortcut unavailable: Ctrl+L is reserved by the browser or operating system'
    );
  });

  it('warns and refuses a file-view-owned key with modifiers', async () => {
    const user = userEvent.setup();
    const onStatus = vi.fn();
    render(<KeyboardShortcutSettings onStatus={onStatus} />);

    await user.click(screen.getByRole('button', { name: 'Change shortcut for New tab' }));
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(mocks.state.setShortcut).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Ctrl+Enter is reserved by the file view');
    expect(onStatus).toHaveBeenLastCalledWith(
      'Shortcut unavailable: Ctrl+Enter is reserved by the file view'
    );
  });

  it('restores all default bindings', async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutSettings onStatus={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Reset keyboard shortcuts' }));
    expect(mocks.state.resetShortcuts).toHaveBeenCalledOnce();
  });
});
