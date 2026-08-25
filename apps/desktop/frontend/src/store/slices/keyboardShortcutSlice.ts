import type { StateCreator } from 'zustand';
import type { KeyboardShortcutSlice, StoreState } from '../types';
import {
  assignShortcut,
  cloneShortcutMap,
  DEFAULT_SHORTCUTS,
  loadShortcutMap,
  saveShortcutMap,
  type Chord,
  type ShortcutId,
} from '../../utils/shortcuts';

export const createKeyboardShortcutSlice: StateCreator<
  StoreState,
  [],
  [],
  KeyboardShortcutSlice
> = (set, get) => ({
  shortcuts: loadShortcutMap(),
  setShortcut: (id: ShortcutId, chord: Chord) => {
    const result = assignShortcut(get().shortcuts, id, chord);
    if (!result.ok) return result;
    set({ shortcuts: result.map });
    saveShortcutMap(result.map);
    return result;
  },
  resetShortcuts: () => {
    const map = cloneShortcutMap(DEFAULT_SHORTCUTS);
    set({ shortcuts: map });
    saveShortcutMap(map);
  },
});
