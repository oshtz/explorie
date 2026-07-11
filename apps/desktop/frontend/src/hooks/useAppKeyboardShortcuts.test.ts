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
    deleteSelection: vi.fn(),
    goUp: vi.fn(),
    refresh: vi.fn(),
    setViewMode: vi.fn(),
    toggleHidden: vi.fn(),
    activateTabOffset: vi.fn(),
    focusSearch: vi.fn(),
    typeToSelect: vi.fn(),
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

  it('dispatches the shortcuts advertised by the overlay and type-to-select', () => {
    const deleteSelection = vi.fn();
    const goUp = vi.fn();
    const refresh = vi.fn();
    const setViewMode = vi.fn();
    const toggleHidden = vi.fn();
    const activateTabOffset = vi.fn();
    const focusSearch = vi.fn();
    const typeToSelect = vi.fn();
    render(
      React.createElement(ShortcutHarness, {
        deleteSelection,
        goUp,
        refresh,
        setViewMode,
        toggleHidden,
        activateTabOffset,
        focusSearch,
        typeToSelect,
      })
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));

    expect(deleteSelection).toHaveBeenCalledOnce();
    expect(goUp).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(setViewMode).toHaveBeenCalledWith('grid');
    expect(toggleHidden).toHaveBeenCalledOnce();
    expect(activateTabOffset).toHaveBeenCalledWith(1);
    expect(focusSearch).toHaveBeenCalledOnce();
    expect(typeToSelect).toHaveBeenCalledWith('r');
  });

  it('does not dispatch app shortcuts behind a modal', () => {
    const addTab = vi.fn();
    render(React.createElement(ShortcutHarness, { addTab }));

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));

    expect(addTab).not.toHaveBeenCalled();
    modal.remove();
  });
});
