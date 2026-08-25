import { getJson, setJson } from './localStorage';

export type ShortcutCategory = 'navigation' | 'file' | 'selection' | 'view' | 'tabs' | 'commands';

export type ShortcutId =
  | 'nav-back'
  | 'nav-forward'
  | 'nav-go-to-folder'
  | 'nav-up'
  | 'nav-add-favorite'
  | 'edit-delete'
  | 'edit-rename'
  | 'edit-undo'
  | 'edit-redo'
  | 'edit-redo-alternate'
  | 'clipboard-copy'
  | 'clipboard-cut'
  | 'clipboard-paste'
  | 'selection-select-all'
  | 'view-list'
  | 'view-grid'
  | 'view-column'
  | 'view-toggle-hidden'
  | 'view-refresh'
  | 'view-quick-look'
  | 'view-increase-thumbnail'
  | 'view-decrease-thumbnail'
  | 'tab-new'
  | 'tab-close'
  | 'tab-next'
  | 'tab-previous'
  | 'search-focus'
  | 'command-palette'
  | 'settings-open'
  | 'help-keyboard-shortcuts'
  | 'debug-toggle';

export type ShortcutMap = Record<ShortcutId, string>;

export interface ShortcutDefinition {
  id: ShortcutId;
  label: string;
  category: ShortcutCategory;
  defaultShortcut: string;
  developmentOnly?: boolean;
}

export const SHORTCUT_STORAGE_KEY = 'explorie:shortcuts' as const;

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'nav-back', label: 'Go back', category: 'navigation', defaultShortcut: 'Alt+ArrowLeft' },
  {
    id: 'nav-forward',
    label: 'Go forward',
    category: 'navigation',
    defaultShortcut: 'Alt+ArrowRight',
  },
  {
    id: 'nav-go-to-folder',
    label: 'Go to folder',
    category: 'navigation',
    defaultShortcut: 'Mod+G',
  },
  {
    id: 'nav-up',
    label: 'Go up one directory',
    category: 'navigation',
    defaultShortcut: 'Backspace',
  },
  {
    id: 'nav-add-favorite',
    label: 'Add current folder to favorites',
    category: 'navigation',
    defaultShortcut: 'Mod+D',
  },
  { id: 'edit-delete', label: 'Delete selected item', category: 'file', defaultShortcut: 'Delete' },
  { id: 'edit-rename', label: 'Rename selected item', category: 'file', defaultShortcut: 'F2' },
  { id: 'edit-undo', label: 'Undo last action', category: 'file', defaultShortcut: 'Mod+Z' },
  { id: 'edit-redo', label: 'Redo last action', category: 'file', defaultShortcut: 'Mod+Y' },
  {
    id: 'edit-redo-alternate',
    label: 'Redo last action (alternate)',
    category: 'file',
    defaultShortcut: 'Mod+Shift+Z',
  },
  {
    id: 'clipboard-copy',
    label: 'Copy selected items',
    category: 'file',
    defaultShortcut: 'Mod+C',
  },
  { id: 'clipboard-cut', label: 'Cut selected items', category: 'file', defaultShortcut: 'Mod+X' },
  { id: 'clipboard-paste', label: 'Paste items', category: 'file', defaultShortcut: 'Mod+V' },
  {
    id: 'selection-select-all',
    label: 'Select all items',
    category: 'selection',
    defaultShortcut: 'Mod+A',
  },
  { id: 'view-list', label: 'List view', category: 'view', defaultShortcut: 'Mod+1' },
  { id: 'view-grid', label: 'Grid view', category: 'view', defaultShortcut: 'Mod+2' },
  { id: 'view-column', label: 'Column view', category: 'view', defaultShortcut: 'Mod+3' },
  {
    id: 'view-toggle-hidden',
    label: 'Toggle hidden files',
    category: 'view',
    defaultShortcut: 'Mod+H',
  },
  { id: 'view-refresh', label: 'Refresh', category: 'view', defaultShortcut: 'F5' },
  {
    id: 'view-quick-look',
    label: 'Quick Look preview',
    category: 'view',
    defaultShortcut: 'Space',
  },
  {
    id: 'view-increase-thumbnail',
    label: 'Increase thumbnail size (Grid)',
    category: 'view',
    defaultShortcut: 'Plus',
  },
  {
    id: 'view-decrease-thumbnail',
    label: 'Decrease thumbnail size (Grid)',
    category: 'view',
    defaultShortcut: 'Minus',
  },
  { id: 'tab-new', label: 'New tab', category: 'tabs', defaultShortcut: 'Mod+T' },
  { id: 'tab-close', label: 'Close current tab', category: 'tabs', defaultShortcut: 'Mod+W' },
  { id: 'tab-next', label: 'Next tab', category: 'tabs', defaultShortcut: 'Mod+Tab' },
  {
    id: 'tab-previous',
    label: 'Previous tab',
    category: 'tabs',
    defaultShortcut: 'Mod+Shift+Tab',
  },
  { id: 'search-focus', label: 'Search files', category: 'commands', defaultShortcut: 'Mod+F' },
  {
    id: 'command-palette',
    label: 'Open command palette',
    category: 'commands',
    defaultShortcut: 'Mod+Shift+P',
  },
  {
    id: 'settings-open',
    label: 'Open settings',
    category: 'commands',
    defaultShortcut: 'Mod+Comma',
  },
  {
    id: 'help-keyboard-shortcuts',
    label: 'Show keyboard shortcuts',
    category: 'commands',
    defaultShortcut: 'Question',
  },
  {
    id: 'debug-toggle',
    label: 'Toggle debug panel (development)',
    category: 'commands',
    defaultShortcut: 'Mod+Shift+D',
    developmentOnly: true,
  },
];

export const DEFAULT_SHORTCUTS: ShortcutMap = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultShortcut])
) as ShortcutMap;

const MODIFIER_ALIASES: Record<string, 'Mod' | 'Alt' | 'Shift'> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  control: 'Mod',
  ctrl: 'Mod',
  meta: 'Mod',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  spacebar: 'Space',
  '+': 'Plus',
  '=': 'Plus',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '?': 'Question',
  '\\': 'Backslash',
  '`': 'Backquote',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  esc: 'Escape',
  return: 'Enter',
};

const DISPLAY_KEY_ALIASES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Plus: '+',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Question: '?',
  Backslash: '\\',
  Backquote: '`',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
};

const IMPLICIT_SHIFT_KEYS = new Set(['Plus', 'Question']);
const NAMED_KEYS = [
  'Space',
  'Plus',
  'Minus',
  'Comma',
  'Period',
  'Slash',
  'Question',
  'Backslash',
  'Backquote',
  'Semicolon',
  'Quote',
  'BracketLeft',
  'BracketRight',
] as const;

function canonicalKey(value: string): string | null {
  if (value === ' ') return 'Space';
  const trimmed = value.trim();
  if (!trimmed) return null;
  const alias = KEY_ALIASES[trimmed.toLowerCase()] ?? KEY_ALIASES[trimmed];
  if (alias) return alias;
  const namedKey = NAMED_KEYS.find((key) => key.toLowerCase() === trimmed.toLowerCase());
  if (namedKey) return namedKey;
  if (/^F(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^Arrow(?:Up|Down|Left|Right)$/.test(trimmed)) return trimmed;
  if (/^(?:Backspace|Delete|Enter|Escape|Home|End|PageUp|PageDown|Tab)$/i.test(trimmed)) {
    return trimmed[0].toUpperCase() + trimmed.slice(1);
  }
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return null;
}

/** Convert a persisted or user-entered shortcut into the canonical storage form. */
export function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '+') return 'Plus';

  const parts = trimmed.split('+');
  const keyPart = parts.pop() || (parts.pop() ?? '');
  const key = canonicalKey(keyPart);
  if (!key) return null;

  const modifiers: Array<'Mod' | 'Alt' | 'Shift'> = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }

  const ordered = (['Mod', 'Alt', 'Shift'] as const).filter((modifier) =>
    modifiers.includes(modifier)
  );
  return [...ordered, key].join('+');
}

/**
 * Exact chords that the browser, operating system, or file views own. The
 * shipped defaults may use a few of these for desktop parity; users cannot
 * assign them to a different action from settings.
 */
export const RESERVED_SHORTCUTS = new Set([
  // These bare keys are handled directly by the file views for opening,
  // selection, and navigation. Keep them out of the user binding namespace
  // so a global shortcut can never fire alongside the view-local action.
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Alt+Enter',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Alt+Backspace',
  'Alt+Escape',
  'Alt+F4',
  'Alt+F10',
  'Alt+Home',
  'Alt+Space',
  'Alt+Tab',
  'Backspace',
  'End',
  'Enter',
  'F1',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F10',
  'F11',
  'F12',
  'Escape',
  'Home',
  'Mod+0',
  'Mod+A',
  'Mod+1',
  'Mod+2',
  'Mod+3',
  'Mod+4',
  'Mod+5',
  'Mod+6',
  'Mod+7',
  'Mod+8',
  'Mod+9',
  'Mod+D',
  'Mod+E',
  'Mod+F',
  'Mod+G',
  'Mod+H',
  'Mod+I',
  'Mod+J',
  'Mod+K',
  'Mod+L',
  'Mod+M',
  'Mod+N',
  'Mod+O',
  'Mod+P',
  'Mod+Q',
  'Mod+R',
  'Mod+S',
  'Mod+U',
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+Plus',
  'Mod+Minus',
  'Mod+Alt+Escape',
  'Mod+Shift+C',
  'Mod+Shift+B',
  'Mod+Shift+Delete',
  'Mod+Shift+D',
  'Mod+Shift+G',
  'Mod+Shift+I',
  'Mod+Shift+J',
  'Mod+Shift+N',
  'Mod+Shift+O',
  'Mod+Shift+P',
  'Mod+Shift+R',
  'Mod+Shift+S',
  'Mod+Shift+V',
  'Mod+Shift+Q',
  'Mod+Shift+M',
  'Mod+Shift+T',
  'Mod+Shift+Tab',
  'Mod+Shift+W',
  'Mod+Shift+3',
  'Mod+Shift+4',
  'Mod+Shift+5',
  'Mod+Shift+Esc',
  'Mod+Alt+I',
  'Mod+Alt+J',
  'Mod+Alt+T',
  'Mod+F4',
  'Mod+F5',
  'Mod+F6',
  'Mod+F10',
  'Mod+Home',
  'Mod+End',
  'Mod+PageUp',
  'Mod+PageDown',
  'Shift+F10',
  'Mod+Space',
  'Mod+Tab',
  'Mod+T',
  'Mod+W',
  'Shift+Tab',
  'Shift+Delete',
  'Tab',
  'Mod+Alt+Delete',
  'Space',
]);

/** File-view keys remain reserved even when a modifier is pressed. */
const APP_OWNED_SHORTCUT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Enter',
  'Escape',
  'Home',
  'Space',
]);

// Function keys with browser, shell, or window-manager meanings remain
// reserved for every modifier variant. F5 stays usable only as the shipped
// refresh binding through isDefaultShortcut/isAllowedPersistedShortcut.
const RESERVED_FUNCTION_KEYS = new Set(['F1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12']);

export function isAppOwnedShortcut(value: unknown): boolean {
  const normalized = normalizeShortcut(value);
  if (!normalized) return false;
  const key = normalized.split('+').pop();
  return key !== undefined && APP_OWNED_SHORTCUT_KEYS.has(key);
}

export function isReservedShortcut(value: unknown): boolean {
  const normalized = normalizeShortcut(value);
  const key = normalized?.split('+').pop();
  return (
    normalized !== null &&
    (RESERVED_SHORTCUTS.has(normalized) ||
      isAppOwnedShortcut(normalized) ||
      (key !== undefined && RESERVED_FUNCTION_KEYS.has(key)))
  );
}

export function isDefaultShortcut(id: ShortcutId, value: unknown): boolean {
  const definition = SHORTCUT_DEFINITIONS.find((candidate) => candidate.id === id);
  const normalized = normalizeShortcut(value);
  return normalized !== null && normalizeShortcut(definition?.defaultShortcut) === normalized;
}

function eventKey(event: Pick<KeyboardEvent, 'key'>): string | null {
  return canonicalKey(event.key);
}

/** Convert a keyboard event to the canonical shortcut form used in settings. */
export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
): string | null {
  const key = eventKey(event);
  if (!key || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push('Mod');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey && !IMPLICIT_SHIFT_KEYS.has(key)) modifiers.push('Shift');
  return [...modifiers, key].join('+');
}

/** Return true when a keyboard event matches a canonical shortcut. */
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  shortcut: string | undefined
): boolean {
  const normalized = normalizeShortcut(shortcut);
  const pressed = shortcutFromKeyboardEvent(event);
  if (!normalized || !pressed) return false;
  return normalized === pressed;
}

export function formatShortcut(shortcut: string | undefined, mac = isMacPlatform()): string {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return 'Unassigned';
  const parts = normalized.split('+');
  const key = parts.pop()!;
  const modifiers = parts.map((part) => (part === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : part));
  const keyLabel = DISPLAY_KEY_ALIASES[key] ?? key;
  return modifiers.length > 0 ? `${modifiers.join('+')}+${keyLabel}` : keyLabel;
}

export function formatShortcutSpaced(shortcut: string | undefined, mac = isMacPlatform()): string {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return 'Unassigned';
  const parts = normalized.split('+');
  const key = parts.pop()!;
  const modifiers = parts.map((part) => (part === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : part));
  const keyLabel = DISPLAY_KEY_ALIASES[key] ?? key;
  return modifiers.length > 0 ? `${modifiers.join(' + ')} + ${keyLabel}` : keyLabel;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`);
}

export function findShortcutConflict(
  shortcuts: Partial<ShortcutMap>,
  id: ShortcutId,
  shortcut: string
): ShortcutId | null {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  for (const definition of SHORTCUT_DEFINITIONS) {
    if (definition.id === id) continue;
    if (normalizeShortcut(shortcuts[definition.id]) === normalized) return definition.id;
  }
  return null;
}

export function getShortcutConflicts(shortcuts: Partial<ShortcutMap>): ShortcutId[][] {
  const conflicts: ShortcutId[][] = [];
  const seen = new Map<string, ShortcutId[]>();
  for (const definition of SHORTCUT_DEFINITIONS) {
    const normalized = normalizeShortcut(shortcuts[definition.id]);
    if (!normalized) continue;
    const ids = seen.get(normalized) ?? [];
    ids.push(definition.id);
    seen.set(normalized, ids);
  }
  for (const ids of seen.values()) {
    if (ids.length > 1) conflicts.push(ids);
  }
  return conflicts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedPersistedShortcut(definition: ShortcutDefinition, shortcut: string): boolean {
  return (
    !isReservedShortcut(shortcut) || normalizeShortcut(definition.defaultShortcut) === shortcut
  );
}

export function loadShortcutMap(): ShortcutMap {
  const saved = getJson(SHORTCUT_STORAGE_KEY);
  if (!isRecord(saved)) return { ...DEFAULT_SHORTCUTS };

  const preferred = SHORTCUT_DEFINITIONS.map((definition) => {
    const normalized = normalizeShortcut(saved[definition.id]);
    return {
      definition,
      shortcut:
        normalized && isAllowedPersistedShortcut(definition, normalized)
          ? normalized
          : normalizeShortcut(definition.defaultShortcut)!,
    };
  });

  // Validate the saved map as a whole so a valid swap of two bindings is not
  // rejected merely because each new value matches the other's shipped default.
  const candidate = Object.fromEntries(
    preferred.map(({ definition, shortcut }) => [definition.id, shortcut])
  ) as ShortcutMap;
  if (getShortcutConflicts(candidate).length === 0) return candidate;

  // Recover deterministically from stale or externally edited storage. Prefer
  // an action's own default before a custom value competing for that chord,
  // then fall back to the first unique saved value. Empty bindings are inert
  // and keep recovery conflict-free if every fallback is already occupied.
  const recovered = {} as ShortcutMap;
  const used = new Set<string>();
  const recoveryOrder = [...preferred].sort((left, right) => {
    const leftIsDefault = left.shortcut === left.definition.defaultShortcut;
    const rightIsDefault = right.shortcut === right.definition.defaultShortcut;
    return Number(rightIsDefault) - Number(leftIsDefault);
  });

  for (const { definition, shortcut } of recoveryOrder) {
    const ownDefault = normalizeShortcut(definition.defaultShortcut)!;
    const chosen = !used.has(shortcut) ? shortcut : !used.has(ownDefault) ? ownDefault : '';
    recovered[definition.id] = chosen;
    if (chosen) used.add(chosen);
  }

  return recovered;
}

export function saveShortcutMap(shortcuts: ShortcutMap): boolean {
  if (getShortcutConflicts(shortcuts).length > 0) return false;
  for (const definition of SHORTCUT_DEFINITIONS) {
    const normalized = normalizeShortcut(shortcuts[definition.id]);
    if (!normalized) return false;
    if (
      isReservedShortcut(normalized) &&
      normalizeShortcut(definition.defaultShortcut) !== normalized
    ) {
      return false;
    }
  }
  return setJson(SHORTCUT_STORAGE_KEY, shortcuts);
}

export function shortcutLabel(id: ShortcutId): string {
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)?.label ?? id;
}
