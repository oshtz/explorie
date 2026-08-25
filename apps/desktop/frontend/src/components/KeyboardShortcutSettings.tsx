import React from 'react';
import styles from './SettingsPanel.module.css';
import { useFileStore } from '../store';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  isAppOwnedShortcut,
  isDefaultShortcut,
  isReservedShortcut,
  SHORTCUT_DEFINITIONS,
  shortcutFromKeyboardEvent,
  shortcutLabel,
  type ShortcutId,
  type ShortcutMap,
} from '../utils/shortcuts';

interface KeyboardShortcutSettingsProps {
  onStatus: (message: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  navigation: 'Navigation',
  file: 'File operations',
  selection: 'Selection',
  view: 'View',
  tabs: 'Tabs',
  commands: 'Search and commands',
};

export function KeyboardShortcutSettings({ onStatus }: KeyboardShortcutSettingsProps) {
  const storedShortcuts = useFileStore((state) => state.shortcuts) as ShortcutMap | undefined;
  const setShortcut = useFileStore((state) => state.setShortcut) as
    | ((id: ShortcutId, shortcut: string) => boolean)
    | undefined;
  const resetShortcuts = useFileStore((state) => state.resetShortcuts) as (() => void) | undefined;
  const shortcuts = storedShortcuts ?? DEFAULT_SHORTCUTS;
  const [capturingId, setCapturingId] = React.useState<ShortcutId | null>(null);
  const [conflictMessage, setConflictMessage] = React.useState('');

  const startCapture = (id: ShortcutId) => {
    setConflictMessage('');
    setCapturingId(id);
    onStatus(`Press a key combination for ${shortcutLabel(id)}`);
  };

  const handleCaptureKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: ShortcutId) => {
    if (capturingId !== id) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setCapturingId(null);
      setConflictMessage('');
      onStatus('Shortcut change cancelled');
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      onStatus('Press a non-modifier key to set the shortcut');
      return;
    }

    const conflictId = findShortcutConflict(shortcuts, id, shortcut);
    if (conflictId) {
      const message = `${formatShortcut(shortcut)} is already assigned to ${shortcutLabel(conflictId)}`;
      setConflictMessage(message);
      onStatus(`Shortcut conflict: ${message}`);
      return;
    }

    if (isReservedShortcut(shortcut) && !isDefaultShortcut(id, shortcut)) {
      const owner = isAppOwnedShortcut(shortcut)
        ? 'the file view'
        : 'the browser or operating system';
      const message = `${formatShortcut(shortcut)} is reserved by ${owner}`;
      setConflictMessage(message);
      onStatus(`Shortcut unavailable: ${message}`);
      return;
    }

    if (!setShortcut || !setShortcut(id, shortcut)) {
      const message = `${formatShortcut(shortcut)} could not be assigned`;
      setConflictMessage(message);
      onStatus(message);
      return;
    }

    setCapturingId(null);
    setConflictMessage('');
    onStatus(`Shortcut updated: ${shortcutLabel(id)} → ${formatShortcut(shortcut)}`);
  };

  const handleReset = () => {
    resetShortcuts?.();
    setCapturingId(null);
    setConflictMessage('');
    onStatus('Keyboard shortcuts restored to defaults');
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Keyboard shortcuts</h2>
      <div className={styles.shortcutIntro}>
        Click a shortcut and press the key combination you want to use. Each combination can be
        assigned to only one action. File-view navigation keys and type-to-select remain fixed.
      </div>
      {(['navigation', 'file', 'selection', 'view', 'tabs', 'commands'] as const).map(
        (category) => (
          <React.Fragment key={category}>
            <h3 className={styles.shortcutCategory}>{CATEGORY_LABELS[category]}</h3>
            {SHORTCUT_DEFINITIONS.filter(
              (definition) =>
                definition.category === category &&
                (!definition.developmentOnly || import.meta.env.DEV)
            ).map((definition) => {
              const isCapturing = capturingId === definition.id;
              return (
                <div className={styles.shortcutRow} key={definition.id}>
                  <div className={styles.rowLabel}>{definition.label}</div>
                  <div className={styles.controls}>
                    <button
                      type="button"
                      className={isCapturing ? styles.shortcutCaptureActive : undefined}
                      aria-label={`Change shortcut for ${definition.label}`}
                      onClick={() => startCapture(definition.id)}
                      onKeyDown={(event) => handleCaptureKeyDown(event, definition.id)}
                    >
                      {isCapturing ? 'Press a key…' : formatShortcut(shortcuts[definition.id])}
                    </button>
                  </div>
                </div>
              );
            })}
          </React.Fragment>
        )
      )}
      {conflictMessage && (
        <div className={styles.shortcutConflict} role="alert">
          {conflictMessage}
        </div>
      )}
      <div className={styles.shortcutActions}>
        <button type="button" onClick={handleReset}>
          Reset keyboard shortcuts
        </button>
      </div>
    </div>
  );
}
