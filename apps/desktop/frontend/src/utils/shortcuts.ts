import { getJson, setJson } from './localStorage';

export const SHORTCUT_STORAGE_KEY = 'explorie:shortcuts' as const;

export const SHORTCUT_IDS = [
  'deleteSelection',
  'goUp',
  'refresh',
  'viewList',
  'viewGrid',
  'viewColumn',
  'toggleHidden',
  'nextTab',
  'prevTab',
  'focusSearch',
  'newTab',
  'closeTab',
  'goBack',
  'goForward',
  'quickLook',
  'goToFolder',
  'commandPalette',
  'addFavorite',
  'showShortcuts',
  'undo',
  'redo',
  'increaseThumbnail',
  'decreaseThumbnail',
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];

export interface Chord {
  key: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type ShortcutMap = Record<ShortcutId, Chord>;

export type ShortcutCategory =
  | 'Navigation'
  | 'File Operations'
  | 'Selection'
  | 'View'
  | 'Tabs'
  | 'Search & Commands';

export interface ShortcutMeta {
  id: ShortcutId;
  label: string;
  category: ShortcutCategory;
  rebindable: boolean;
  suppressInEditable: boolean;
}

export interface OverlayShortcut {
  id: string;
  keys: string;
  description: string;
  category: ShortcutCategory;
}

export type ShortcutAssignError = 'reserved' | 'conflict' | 'unknown' | 'invalid';

export interface ShortcutAssignResult {
  ok: boolean;
  map: ShortcutMap;
  error?: ShortcutAssignError;
  conflictId?: ShortcutId;
}

export const SHORTCUT_META: Record<ShortcutId, ShortcutMeta> = {
  deleteSelection: {
    id: 'deleteSelection',
    label: 'Delete selected item',
    category: 'File Operations',
    rebindable: true,
    suppressInEditable: true,
  },
  goUp: {
    id: 'goUp',
    label: 'Go up one directory',
    category: 'Navigation',
    rebindable: true,
    suppressInEditable: true,
  },
  refresh: {
    id: 'refresh',
    label: 'Refresh',
    category: 'View',
    rebindable: true,
    suppressInEditable: false,
  },
  viewList: {
    id: 'viewList',
    label: 'List view',
    category: 'View',
    rebindable: true,
    suppressInEditable: false,
  },
  viewGrid: {
    id: 'viewGrid',
    label: 'Grid view',
    category: 'View',
    rebindable: true,
    suppressInEditable: false,
  },
  viewColumn: {
    id: 'viewColumn',
    label: 'Column view',
    category: 'View',
    rebindable: true,
    suppressInEditable: false,
  },
  toggleHidden: {
    id: 'toggleHidden',
    label: 'Toggle hidden files',
    category: 'View',
    rebindable: true,
    suppressInEditable: true,
  },
  nextTab: {
    id: 'nextTab',
    label: 'Next tab',
    category: 'Tabs',
    rebindable: true,
    suppressInEditable: false,
  },
  prevTab: {
    id: 'prevTab',
    label: 'Previous tab',
    category: 'Tabs',
    rebindable: true,
    suppressInEditable: false,
  },
  focusSearch: {
    id: 'focusSearch',
    label: 'Search files',
    category: 'Search & Commands',
    rebindable: true,
    suppressInEditable: false,
  },
  newTab: {
    id: 'newTab',
    label: 'New tab',
    category: 'Tabs',
    rebindable: true,
    suppressInEditable: false,
  },
  closeTab: {
    id: 'closeTab',
    label: 'Close current tab',
    category: 'Tabs',
    rebindable: true,
    suppressInEditable: false,
  },
  goBack: {
    id: 'goBack',
    label: 'Go back',
    category: 'Navigation',
    rebindable: true,
    suppressInEditable: false,
  },
  goForward: {
    id: 'goForward',
    label: 'Go forward',
    category: 'Navigation',
    rebindable: true,
    suppressInEditable: false,
  },
  quickLook: {
    id: 'quickLook',
    label: 'Quick Look preview',
    category: 'View',
    rebindable: false,
    suppressInEditable: true,
  },
  goToFolder: {
    id: 'goToFolder',
    label: 'Go to folder',
    category: 'Navigation',
    rebindable: true,
    suppressInEditable: true,
  },
  commandPalette: {
    id: 'commandPalette',
    label: 'Open command palette',
    category: 'Search & Commands',
    rebindable: true,
    suppressInEditable: false,
  },
  addFavorite: {
    id: 'addFavorite',
    label: 'Add to favorites',
    category: 'File Operations',
    rebindable: true,
    suppressInEditable: true,
  },
  showShortcuts: {
    id: 'showShortcuts',
    label: 'Show keyboard shortcuts',
    category: 'Search & Commands',
    rebindable: true,
    suppressInEditable: true,
  },
  undo: {
    id: 'undo',
    label: 'Undo last action',
    category: 'File Operations',
    rebindable: true,
    suppressInEditable: true,
  },
  redo: {
    id: 'redo',
    label: 'Redo last action',
    category: 'File Operations',
    rebindable: true,
    suppressInEditable: true,
  },
  increaseThumbnail: {
    id: 'increaseThumbnail',
    label: 'Increase thumbnail size (Grid)',
    category: 'View',
    rebindable: true,
    suppressInEditable: true,
  },
  decreaseThumbnail: {
    id: 'decreaseThumbnail',
    label: 'Decrease thumbnail size (Grid)',
    category: 'View',
    rebindable: true,
    suppressInEditable: true,
  },
};

const DISPLAY_ONLY_OVERLAY: OverlayShortcut[] = [
  {
    id: 'openItem',
    keys: 'Enter',
    description: 'Open selected item',
    category: 'Navigation',
  },
  {
    id: 'navigateFiles',
    keys: 'Arrow Keys',
    description: 'Navigate between files',
    category: 'Navigation',
  },
  {
    id: 'selectFirst',
    keys: 'Home',
    description: 'Select first item',
    category: 'Navigation',
  },
  {
    id: 'selectLast',
    keys: 'End',
    description: 'Select last item',
    category: 'Navigation',
  },
  {
    id: 'rename',
    keys: 'F2',
    description: 'Rename selected item',
    category: 'File Operations',
  },
  {
    id: 'copy',
    keys: 'Ctrl + C',
    description: 'Copy selected items',
    category: 'File Operations',
  },
  {
    id: 'cut',
    keys: 'Ctrl + X',
    description: 'Cut selected items',
    category: 'File Operations',
  },
  {
    id: 'paste',
    keys: 'Ctrl + V',
    description: 'Paste items',
    category: 'File Operations',
  },
  {
    id: 'selectAll',
    keys: 'Ctrl + A',
    description: 'Select all items',
    category: 'Selection',
  },
  {
    id: 'toggleSelect',
    keys: 'Ctrl + Click',
    description: 'Toggle item selection',
    category: 'Selection',
  },
  {
    id: 'rangeSelect',
    keys: 'Shift + Click',
    description: 'Select range of items',
    category: 'Selection',
  },
  {
    id: 'clearSelection',
    keys: 'Escape',
    description: 'Clear selection',
    category: 'Selection',
  },
  {
    id: 'typeToSelect',
    keys: 'Type letters',
    description: 'Select by filename',
    category: 'Selection',
  },
  {
    id: 'reorderFavorite',
    keys: 'Alt + Up/Down',
    description: 'Reorder focused Favorite',
    category: 'Tabs',
  },
];

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  deleteSelection: { key: 'Delete' },
  goUp: { key: 'Backspace' },
  refresh: { key: 'F5' },
  viewList: { key: '1', mod: true },
  viewGrid: { key: '2', mod: true },
  viewColumn: { key: '3', mod: true },
  toggleHidden: { key: 'h', mod: true },
  nextTab: { key: 'Tab', mod: true },
  prevTab: { key: 'Tab', mod: true, shift: true },
  focusSearch: { key: 'f', mod: true },
  newTab: { key: 't', mod: true },
  closeTab: { key: 'w', mod: true },
  goBack: { key: 'ArrowLeft', alt: true },
  goForward: { key: 'ArrowRight', alt: true },
  quickLook: { key: 'Space' },
  goToFolder: { key: 'g', mod: true },
  commandPalette: { key: 'p', mod: true, shift: true },
  addFavorite: { key: 'd', mod: true },
  showShortcuts: { key: '?' },
  undo: { key: 'z', mod: true },
  redo: { key: 'y', mod: true },
  increaseThumbnail: { key: '+' },
  decreaseThumbnail: { key: '-' },
};

export const COMMAND_SHORTCUT_IDS: Partial<Record<string, ShortcutId>> = {
  'nav-back': 'goBack',
  'nav-forward': 'goForward',
  'nav-go-to-folder': 'goToFolder',
  'view-list': 'viewList',
  'view-grid': 'viewGrid',
  'view-column': 'viewColumn',
  'view-toggle-hidden': 'toggleHidden',
  'view-refresh': 'refresh',
  'tab-new': 'newTab',
  'tab-close': 'closeTab',
  'edit-undo': 'undo',
  'edit-redo': 'redo',
  'nav-add-favorite': 'addFavorite',
  'help-keyboard-shortcuts': 'showShortcuts',
};

const DISPLAY_KEY: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Space: 'Space',
  ' ': 'Space',
};

export function cloneShortcutMap(map: ShortcutMap = DEFAULT_SHORTCUTS): ShortcutMap {
  const next = {} as ShortcutMap;
  for (const id of SHORTCUT_IDS) {
    next[id] = { ...map[id] };
  }
  return next;
}

export function normalizeChordKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key.length === 1 && /[A-Z]/.test(key)) return key.toLowerCase();
  return key;
}

export function normalizeChord(chord: Chord): Chord {
  const next: Chord = { key: normalizeChordKey(chord.key) };
  if (chord.mod) next.mod = true;
  if (chord.alt) next.alt = true;
  if (chord.shift) next.shift = true;
  return next;
}

export function serializeChord(chord: Chord): string {
  const normalized = normalizeChord(chord);
  const parts: string[] = [];
  if (normalized.mod) parts.push('Mod');
  if (normalized.alt) parts.push('Alt');
  if (normalized.shift) parts.push('Shift');
  parts.push(normalized.key);
  return parts.join('+');
}

export function parseChord(value: unknown): Chord | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const tokens = value.split('+').filter(Boolean);
  if (tokens.length === 0) return null;
  const key = tokens[tokens.length - 1];
  if (!key) return null;
  const flags = new Set(tokens.slice(0, -1));
  for (const flag of flags) {
    if (
      flag !== 'Mod' &&
      flag !== 'Ctrl' &&
      flag !== 'Cmd' &&
      flag !== 'Meta' &&
      flag !== 'Alt' &&
      flag !== 'Shift'
    ) {
      return null;
    }
  }
  return normalizeChord({
    key,
    mod: flags.has('Mod') || flags.has('Ctrl') || flags.has('Cmd') || flags.has('Meta'),
    alt: flags.has('Alt'),
    shift: flags.has('Shift'),
  });
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  const left = normalizeChord(a);
  const right = normalizeChord(b);
  return (
    left.key === right.key &&
    !!left.mod === !!right.mod &&
    !!left.alt === !!right.alt &&
    !!left.shift === !!right.shift
  );
}

export function isReservedChord(chord: Chord): boolean {
  const normalized = normalizeChord(chord);
  if (normalized.key === 'Escape') return true;
  return normalized.key === 'Space' && !normalized.mod && !normalized.alt && !normalized.shift;
}

function shiftMatches(bound: Chord, event: KeyboardEvent): boolean {
  if (bound.shift) return event.shiftKey;
  const key = bound.key;
  if (key === 'Tab' || key === 'Space' || (/^[a-z0-9]$/i.test(key) && key.length === 1)) {
    return !event.shiftKey;
  }
  if (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Delete' ||
    key === 'Backspace' ||
    key === 'Escape' ||
    key === 'Enter' ||
    key === 'Home' ||
    key === 'End' ||
    /^F\d+$/.test(key)
  ) {
    return !event.shiftKey;
  }
  return true;
}

function keysMatch(boundKey: string, eventKey: string): boolean {
  const bound = normalizeChordKey(boundKey);
  const event = normalizeChordKey(eventKey);
  if (bound === event) return true;
  if ((bound === '+' || bound === '=') && (event === '+' || event === '=')) return true;
  return false;
}

export function chordFromEvent(event: KeyboardEvent): Chord {
  return normalizeChord({
    key: event.key,
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

export function eventMatchesChord(event: KeyboardEvent, chord: Chord): boolean {
  const bound = normalizeChord(chord);
  const mod = event.ctrlKey || event.metaKey;
  if (!!bound.mod !== mod) return false;
  if (!!bound.alt !== event.altKey) return false;
  if (!keysMatch(bound.key, event.key)) return false;
  return shiftMatches(bound, event);
}

export function formatChordDisplay(chord: Chord, spaced = false): string {
  const normalized = normalizeChord(chord);
  const parts: string[] = [];
  if (normalized.mod) parts.push('Ctrl');
  if (normalized.alt) parts.push('Alt');
  if (normalized.shift) parts.push('Shift');
  parts.push(
    DISPLAY_KEY[normalized.key] ??
      (normalized.key.length === 1 ? normalized.key.toUpperCase() : normalized.key)
  );
  return parts.join(spaced ? ' + ' : '+');
}

export function formatChordAria(chord: Chord): string {
  const normalized = normalizeChord(chord);
  const parts: string[] = [];
  if (normalized.mod) parts.push('Control');
  if (normalized.alt) parts.push('Alt');
  if (normalized.shift) parts.push('Shift');
  const key =
    normalized.key === 'Space'
      ? 'Space'
      : normalized.key.length === 1
        ? normalized.key.toUpperCase()
        : normalized.key;
  parts.push(key);
  return parts.join('+');
}

export function findChordConflict(
  map: ShortcutMap,
  id: ShortcutId,
  chord: Chord
): ShortcutId | null {
  for (const other of SHORTCUT_IDS) {
    if (other === id) continue;
    if (chordsEqual(map[other], chord)) return other;
  }
  return null;
}

export function isValidShortcutMap(map: ShortcutMap): boolean {
  const seen = new Set<string>();
  for (const id of SHORTCUT_IDS) {
    const chord = map[id];
    if (!chord || !chord.key) return false;
    const normalized = normalizeChord(chord);
    if (isReservedChord(normalized) && id !== 'quickLook') return false;
    if (id === 'quickLook' && !chordsEqual(normalized, DEFAULT_SHORTCUTS.quickLook)) return false;
    const serialized = serializeChord(normalized);
    if (seen.has(serialized)) return false;
    seen.add(serialized);
  }
  return true;
}

export function assignShortcut(
  map: ShortcutMap,
  id: ShortcutId,
  chord: Chord
): ShortcutAssignResult {
  if (!SHORTCUT_IDS.includes(id)) {
    return { ok: false, map, error: 'unknown' };
  }
  if (!SHORTCUT_META[id].rebindable) {
    return { ok: false, map, error: 'reserved' };
  }
  const normalized = normalizeChord(chord);
  if (!normalized.key) {
    return { ok: false, map, error: 'invalid' };
  }
  if (isReservedChord(normalized)) {
    return { ok: false, map, error: 'reserved' };
  }
  const conflictId = findChordConflict(map, id, normalized);
  if (conflictId) {
    return { ok: false, map, error: 'conflict', conflictId };
  }
  const next = cloneShortcutMap(map);
  next[id] = normalized;
  if (!isValidShortcutMap(next)) {
    return { ok: false, map, error: 'invalid' };
  }
  return { ok: true, map: next };
}

export function matchShortcut(map: ShortcutMap, event: KeyboardEvent): ShortcutId | null {
  for (const id of SHORTCUT_IDS) {
    if (eventMatchesChord(event, map[id])) return id;
  }
  return null;
}

export function loadShortcutMap(): ShortcutMap {
  const saved = getJson(SHORTCUT_STORAGE_KEY);
  const candidate = cloneShortcutMap(DEFAULT_SHORTCUTS);
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const id of SHORTCUT_IDS) {
      const parsed = parseChord(saved[id]);
      if (parsed) candidate[id] = parsed;
    }
  }
  if (!isValidShortcutMap(candidate)) return cloneShortcutMap(DEFAULT_SHORTCUTS);
  return candidate;
}

export function saveShortcutMap(map: ShortcutMap): boolean {
  const serialized = {} as Record<ShortcutId, string>;
  for (const id of SHORTCUT_IDS) {
    serialized[id] = serializeChord(map[id]);
  }
  return setJson(SHORTCUT_STORAGE_KEY, serialized);
}

export function buildOverlayShortcuts(map: ShortcutMap): OverlayShortcut[] {
  const live: OverlayShortcut[] = SHORTCUT_IDS.map((id) => ({
    id,
    keys: formatChordDisplay(map[id], true),
    description: SHORTCUT_META[id].label,
    category: SHORTCUT_META[id].category,
  }));
  return [...live, ...DISPLAY_ONLY_OVERLAY];
}

export function overlayCategories(map: ShortcutMap): ShortcutCategory[] {
  const order: ShortcutCategory[] = [
    'Navigation',
    'File Operations',
    'Selection',
    'View',
    'Tabs',
    'Search & Commands',
  ];
  const present = new Set(buildOverlayShortcuts(map).map((item) => item.category));
  return order.filter((category) => present.has(category));
}

export function conflictMessage(conflictId: ShortcutId): string {
  return `Already used by ${SHORTCUT_META[conflictId].label}`;
}

export function reservedMessage(): string {
  return 'Space for Quick Look and Escape for dismiss are reserved';
}

export const REBINDABLE_SHORTCUT_IDS = SHORTCUT_IDS.filter((id) => SHORTCUT_META[id].rebindable);
