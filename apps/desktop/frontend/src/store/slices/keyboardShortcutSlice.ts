import type { StateCreator } from 'zustand';
import type { KeyboardShortcutSlice, StoreState } from '../types';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  isDefaultShortcut,
  isReservedShortcut,
  loadShortcutMap,
  normalizeShortcut,
  saveShortcutMap,
  type ShortcutId,
} from '../../utils/shortcuts';

export const createKeyboardShortcutSlice: StateCreator<
  StoreState,
  [],
  [],
  KeyboardShortcutSlice
> = (set, get) => ({
  shortcuts: loadShortcutMap(),
  setShortcut: (id: ShortcutId, shortcut: string) => {
    const normalized = normalizeShortcut(shortcut);
    if (!normalized) return false;

    const current = get().shortcuts;
    if (findShortcutConflict(current, id, normalized)) return false;
    if (isReservedShortcut(normalized) && !isDefaultShortcut(id, normalized)) {
      return false;
    }

    const next = { ...current, [id]: normalized };
    if (!saveShortcutMap(next)) return false;
    set({ shortcuts: next });
    return true;
  },
  resetShortcuts: () => {
    const next = { ...DEFAULT_SHORTCUTS };
    saveShortcutMap(next);
    set({ shortcuts: next });
  },
});
