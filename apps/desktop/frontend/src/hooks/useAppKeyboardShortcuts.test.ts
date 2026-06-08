import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppKeyboardShortcuts } from './useAppKeyboardShortcuts';

function ShortcutHarness(props: Partial<Parameters<typeof useAppKeyboardShortcuts>[0]>) {
  useAppKeyboardShortcuts({
    activeTabId: 'tab-1',
    currentPath: '/root',
    selectedFileIsPreviewable: true,
    isQuickLookOpen: false,
    viewMode: 'list',
    canUndo: true,
    canRedo: true,
    addTab: vi.fn(),
    closeTab: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    openQuickLook: vi.fn(),
    openGoToFolder: vi.fn(),
    openCommandPalette: vi.fn(),
    toggleDebugPanel: vi.fn(),
    addFavorite: vi.fn(),
    toggleShortcutsOverlay: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    increaseThumbnailSize: vi.fn(),
    decreaseThumbnailSize: vi.fn(),
    ...props,
  });
  return React.createElement('input', { 'aria-label': 'editable' });
}

describe('useAppKeyboardShortcuts', () => {
  afterEach(() => {
    cleanup();
  });

  it('dispatches app shortcuts from the window', () => {
    const addTab = vi.fn();
    const openQuickLook = vi.fn();
    const undo = vi.fn();

    render(
      React.createElement(ShortcutHarness, {
        addTab,
        openQuickLook,
        undo,
      })
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));

    expect(addTab).toHaveBeenCalledTimes(1);
    expect(openQuickLook).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('suppresses text-destructive shortcuts from editable targets', () => {
    const openQuickLook = vi.fn();
    const openGoToFolder = vi.fn();
    const addFavorite = vi.fn();

    const { getByLabelText } = render(
      React.createElement(ShortcutHarness, {
        openQuickLook,
        openGoToFolder,
        addFavorite,
      })
    );
    const input = getByLabelText('editable');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));

    expect(openQuickLook).not.toHaveBeenCalled();
    expect(openGoToFolder).not.toHaveBeenCalled();
    expect(addFavorite).not.toHaveBeenCalled();
  });

  it('routes grid thumbnail shortcuts only in grid view', () => {
    const increaseThumbnailSize = vi.fn();
    const decreaseThumbnailSize = vi.fn();

    render(
      React.createElement(ShortcutHarness, {
        viewMode: 'grid',
        increaseThumbnailSize,
        decreaseThumbnailSize,
      })
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));

    expect(increaseThumbnailSize).toHaveBeenCalledTimes(1);
    expect(decreaseThumbnailSize).toHaveBeenCalledTimes(1);
  });
});
