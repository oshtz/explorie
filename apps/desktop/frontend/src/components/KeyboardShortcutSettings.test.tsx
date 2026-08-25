import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useFileStore } from '../store';
import { cloneShortcutMap, DEFAULT_SHORTCUTS } from '../utils/shortcuts';
import { KeyboardShortcutSettings } from './KeyboardShortcutSettings';

describe('KeyboardShortcutSettings', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    useFileStore.setState({ shortcuts: cloneShortcutMap(DEFAULT_SHORTCUTS) });
  });

  it('rebinds a shortcut and refuses conflicts', async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutSettings />);

    await user.click(screen.getByRole('button', { name: 'Rebind New tab' }));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });

    expect(screen.getByRole('button', { name: 'Rebind New tab' })).toHaveTextContent('Ctrl + N');
    expect(useFileStore.getState().shortcuts.newTab).toEqual({ key: 'n', mod: true });
    expect(window.localStorage.getItem('explorie:shortcuts')).toContain('"newTab":"Mod+n"');

    await user.click(screen.getByRole('button', { name: 'Rebind Close current tab' }));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });

    expect(screen.getByRole('alert')).toHaveTextContent('Already used by New tab');
    expect(useFileStore.getState().shortcuts.closeTab).toEqual(DEFAULT_SHORTCUTS.closeTab);
  });

  it('refuses Space and restores defaults', async () => {
    const user = userEvent.setup();
    useFileStore.getState().setShortcut('newTab', { key: 'n', mod: true });
    render(<KeyboardShortcutSettings />);

    await user.click(screen.getByRole('button', { name: 'Rebind New tab' }));
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByRole('alert')).toHaveTextContent('Space for Quick Look');

    await user.click(screen.getByRole('button', { name: 'Reset shortcuts' }));
    expect(screen.getByRole('button', { name: 'Rebind New tab' })).toHaveTextContent('Ctrl + T');
    expect(useFileStore.getState().shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });
});
