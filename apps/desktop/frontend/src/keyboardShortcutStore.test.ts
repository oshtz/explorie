import { beforeEach, describe, expect, it } from 'vitest';
import { useFileStore } from './store';
import { DEFAULT_SHORTCUTS, loadShortcutMap, SHORTCUT_STORAGE_KEY } from './utils/shortcuts';

describe('keyboard shortcut store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useFileStore.getState().resetShortcuts();
  });

  it('persists a rebind and rejects a conflicting assignment', () => {
    const store = useFileStore.getState();

    expect(store.setShortcut('tab-new', 'Ctrl+Alt+K')).toBe(true);
    expect(useFileStore.getState().shortcuts['tab-new']).toBe('Mod+Alt+K');

    expect(useFileStore.getState().setShortcut('tab-close', 'Mod+Alt+K')).toBe(false);
    expect(useFileStore.getState().shortcuts['tab-close']).toBe(DEFAULT_SHORTCUTS['tab-close']);
    expect(JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? '{}')).toMatchObject({
      'tab-new': 'Mod+Alt+K',
      'tab-close': DEFAULT_SHORTCUTS['tab-close'],
    });
  });

  it('restores persisted bindings and reset writes the defaults back', () => {
    const store = useFileStore.getState();
    expect(store.setShortcut('tab-new', 'Ctrl+Alt+K')).toBe(true);

    expect(loadShortcutMap()['tab-new']).toBe('Mod+Alt+K');

    store.resetShortcuts();
    expect(loadShortcutMap()).toEqual(DEFAULT_SHORTCUTS);
    expect(JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? '{}')).toEqual(
      DEFAULT_SHORTCUTS
    );
  });

  it('refuses a browser or operating-system chord at bind time', () => {
    const store = useFileStore.getState();

    expect(store.setShortcut('tab-new', 'Ctrl+L')).toBe(false);
    expect(store.shortcuts['tab-new']).toBe(DEFAULT_SHORTCUTS['tab-new']);
    expect(store.setShortcut('tab-new', 'Ctrl+K')).toBe(false);
    expect(store.shortcuts['tab-new']).toBe(DEFAULT_SHORTCUTS['tab-new']);
  });

  it('refuses view-owned keys at bind time', () => {
    const store = useFileStore.getState();

    for (const shortcut of [
      'Enter',
      'Space',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'Ctrl+Enter',
      'Shift+Space',
      'Ctrl+ArrowRight',
      'Alt+Home',
    ]) {
      expect(store.setShortcut('tab-new', shortcut), shortcut).toBe(false);
    }

    expect(useFileStore.getState().shortcuts['tab-new']).toBe(DEFAULT_SHORTCUTS['tab-new']);
  });

  it('keeps view-local rename and select-all chords collision-free', () => {
    const store = useFileStore.getState();

    expect(store.setShortcut('tab-new', 'F2')).toBe(false);
    expect(store.setShortcut('tab-new', 'Ctrl+A')).toBe(false);
    expect(store.setShortcut('edit-rename', 'Ctrl+Alt+K')).toBe(true);
    expect(store.setShortcut('tab-new', 'F2')).toBe(true);
    expect(store.setShortcut('tab-new', 'Ctrl+Alt+L')).toBe(true);
    expect(store.setShortcut('edit-rename', 'F2')).toBe(true);
  });

  it('persists a swapped pair across a fresh load', () => {
    const store = useFileStore.getState();

    expect(store.setShortcut('view-decrease-thumbnail', 'F8')).toBe(true);
    expect(store.setShortcut('edit-delete', 'Minus')).toBe(true);
    expect(store.setShortcut('view-decrease-thumbnail', 'Delete')).toBe(true);

    expect(loadShortcutMap()).toMatchObject({
      'edit-delete': 'Minus',
      'view-decrease-thumbnail': 'Delete',
    });
  });
});
