import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignShortcut,
  cloneShortcutMap,
  DEFAULT_SHORTCUTS,
  eventMatchesChord,
  formatChordAria,
  formatChordDisplay,
  loadShortcutMap,
  matchShortcut,
  saveShortcutMap,
  serializeChord,
  SHORTCUT_IDS,
  SHORTCUT_STORAGE_KEY,
} from './shortcuts';

describe('shortcuts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('refuses a chord that is already bound', () => {
    const result = assignShortcut(DEFAULT_SHORTCUTS, 'newTab', DEFAULT_SHORTCUTS.focusSearch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('conflict');
    expect(result.conflictId).toBe('focusSearch');
    expect(result.map).toBe(DEFAULT_SHORTCUTS);
  });

  it('refuses reserved Space and Escape', () => {
    expect(assignShortcut(DEFAULT_SHORTCUTS, 'newTab', { key: 'Space' }).error).toBe('reserved');
    expect(assignShortcut(DEFAULT_SHORTCUTS, 'newTab', { key: 'Escape' }).error).toBe('reserved');
    expect(assignShortcut(DEFAULT_SHORTCUTS, 'quickLook', { key: 'q' }).error).toBe('reserved');
  });

  it('persists a whole-map swap across load', () => {
    const first = assignShortcut(cloneShortcutMap(DEFAULT_SHORTCUTS), 'redo', {
      key: 'k',
      mod: true,
    });
    expect(first.ok).toBe(true);
    const swapped = assignShortcut(first.map, 'undo', { key: 'y', mod: true });
    expect(swapped.ok).toBe(true);
    const restoredRedo = assignShortcut(swapped.map, 'redo', { key: 'z', mod: true });
    expect(restoredRedo.ok).toBe(true);

    saveShortcutMap(restoredRedo.map);
    expect(window.localStorage.getItem(SHORTCUT_STORAGE_KEY)).toContain('"undo":"Mod+y"');

    const loaded = loadShortcutMap();
    expect(loaded.undo).toEqual({ key: 'y', mod: true });
    expect(loaded.redo).toEqual({ key: 'z', mod: true });
    expect(loaded.newTab).toEqual(DEFAULT_SHORTCUTS.newTab);
  });

  it('falls back to defaults when a saved map has duplicates', () => {
    const serialized = Object.fromEntries(
      SHORTCUT_IDS.map((id) => [id, serializeChord(DEFAULT_SHORTCUTS[id])])
    );
    serialized.newTab = 'Mod+W';
    serialized.closeTab = 'Mod+W';
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(serialized));
    expect(loadShortcutMap()).toEqual(DEFAULT_SHORTCUTS);
  });

  it('matches events against the live map', () => {
    const map = assignShortcut(cloneShortcutMap(DEFAULT_SHORTCUTS), 'newTab', {
      key: 'n',
      mod: true,
    }).map;
    const rebound = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true });
    const oldChord = new KeyboardEvent('keydown', { key: 't', ctrlKey: true });
    expect(matchShortcut(map, rebound)).toBe('newTab');
    expect(matchShortcut(map, oldChord)).toBeNull();
    expect(eventMatchesChord(rebound, map.newTab)).toBe(true);
    expect(formatChordDisplay(map.newTab, true)).toBe('Ctrl + N');
    expect(formatChordAria(map.goBack)).toBe('Alt+ArrowLeft');
  });
});
