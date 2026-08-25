import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  formatShortcutSpaced,
  getShortcutConflicts,
  isReservedShortcut,
  loadShortcutMap,
  matchesShortcut,
  normalizeShortcut,
  SHORTCUT_STORAGE_KEY,
  shortcutFromKeyboardEvent,
} from './shortcuts';

describe('shortcuts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('normalizes aliases and keyboard events into portable bindings', () => {
    expect(normalizeShortcut('Ctrl+Shift+P')).toBe('Mod+Shift+P');
    expect(normalizeShortcut('Alt+ArrowLeft')).toBe('Alt+ArrowLeft');
    expect(normalizeShortcut('Ctrl+,')).toBe('Mod+Comma');
    expect(normalizeShortcut('Ctrl+Control')).toBeNull();
    expect(
      shortcutFromKeyboardEvent({
        key: 'p',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBe('Mod+Shift+P');
    expect(
      shortcutFromKeyboardEvent({
        key: '?',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBe('Question');
  });

  it('matches modifiers exactly and formats bindings for the platform UI', () => {
    expect(
      matchesShortcut(
        { key: 't', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
        'Mod+T'
      )
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: 't', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true },
        'Mod+T'
      )
    ).toBe(false);
    expect(formatShortcut('Mod+Comma', false)).toBe('Ctrl+,');
    expect(formatShortcutSpaced('Mod+Shift+P', false)).toBe('Ctrl + Shift + P');
  });

  it('detects conflicts and keeps duplicate persisted values out of the active map', () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, 'tab-new': 'Mod+K' };
    expect(findShortcutConflict(shortcuts, 'tab-close', 'Mod+K')).toBe('tab-new');
    expect(getShortcutConflicts({ ...shortcuts, 'tab-close': 'Mod+K' })).toEqual([
      ['tab-new', 'tab-close'],
    ]);

    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ 'tab-new': 'Ctrl+Alt+K', 'tab-close': 'Ctrl+Alt+K' })
    );
    const loaded = loadShortcutMap();
    expect(loaded['tab-new']).toBe('Mod+Alt+K');
    expect(loaded['tab-close']).toBe(DEFAULT_SHORTCUTS['tab-close']);
  });

  it('identifies browser and operating-system chords that cannot be captured', () => {
    expect(isReservedShortcut('Ctrl+L')).toBe(true);
    expect(isReservedShortcut('Ctrl+G')).toBe(true);
    expect(isReservedShortcut('Ctrl+K')).toBe(true);
    expect(isReservedShortcut('Ctrl+C')).toBe(true);
    expect(isReservedShortcut('Ctrl+V')).toBe(true);
    expect(isReservedShortcut('Tab')).toBe(true);
    expect(isReservedShortcut('Shift+Tab')).toBe(true);
    expect(isReservedShortcut('Ctrl+Shift+D')).toBe(true);
    expect(isReservedShortcut('Ctrl+Shift+V')).toBe(true);
    expect(isReservedShortcut('Ctrl+PageUp')).toBe(true);
    expect(isReservedShortcut('Ctrl+F4')).toBe(true);
    expect(isReservedShortcut('Ctrl+F5')).toBe(true);
    expect(isReservedShortcut('Ctrl+Escape')).toBe(true);
    expect(isReservedShortcut('Shift+F10')).toBe(true);
    expect(isReservedShortcut('F3')).toBe(true);
    expect(isReservedShortcut('F4')).toBe(true);
    expect(isReservedShortcut('F10')).toBe(true);
    expect(isReservedShortcut('Escape')).toBe(true);
    expect(isReservedShortcut('Alt+F4')).toBe(true);
    expect(isReservedShortcut('Ctrl+Alt+Delete')).toBe(true);
    expect(isReservedShortcut('Ctrl+Alt+K')).toBe(false);
  });

  it('reserves bare view-owned keys from global shortcut bindings', () => {
    for (const shortcut of [
      'Enter',
      'Space',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
    ]) {
      expect(isReservedShortcut(shortcut), shortcut).toBe(true);
    }

    for (const shortcut of ['Ctrl+Enter', 'Shift+Space', 'Ctrl+ArrowRight', 'Alt+Home']) {
      expect(isReservedShortcut(shortcut), shortcut).toBe(true);
    }
  });

  it('restores a persisted reserved chord only when it is the shipped default', () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ 'tab-new': 'Ctrl+L', 'view-refresh': 'F5' })
    );

    const loaded = loadShortcutMap();
    expect(loaded['tab-new']).toBe(DEFAULT_SHORTCUTS['tab-new']);
    expect(loaded['view-refresh']).toBe('F5');
  });

  it('restores persisted view-owned keys to defaults when they are not the shipped default', () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({
        'tab-new': 'Ctrl+Enter',
        'view-quick-look': 'Ctrl+ArrowRight',
      })
    );

    const loaded = loadShortcutMap();
    expect(loaded['tab-new']).toBe(DEFAULT_SHORTCUTS['tab-new']);
    expect(loaded['view-quick-look']).toBe(DEFAULT_SHORTCUTS['view-quick-look']);
  });

  it('restores a valid persisted swap as one binding map', () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_SHORTCUTS,
        'edit-delete': 'Minus',
        'view-decrease-thumbnail': 'Delete',
      })
    );

    expect(loadShortcutMap()).toMatchObject({
      'edit-delete': 'Minus',
      'view-decrease-thumbnail': 'Delete',
    });
  });
});
