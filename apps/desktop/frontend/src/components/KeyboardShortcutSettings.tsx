import React, { useEffect, useState } from 'react';
import { useFileStore } from '../store';
import {
  chordFromEvent,
  conflictMessage,
  formatChordDisplay,
  REBINDABLE_SHORTCUT_IDS,
  reservedMessage,
  SHORTCUT_META,
  type ShortcutId,
} from '../utils/shortcuts';
import styles from './KeyboardShortcutSettings.module.css';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

export function KeyboardShortcutSettings() {
  const shortcuts = useFileStore((state) => state.shortcuts);
  const setShortcut = useFileStore((state) => state.setShortcut);
  const resetShortcuts = useFileStore((state) => state.resetShortcuts);
  const [listeningId, setListeningId] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!listeningId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setListeningId(null);
        setError(null);
        return;
      }

      const result = setShortcut(listeningId, chordFromEvent(event));
      if (!result.ok) {
        if (result.error === 'conflict' && result.conflictId) {
          setError(conflictMessage(result.conflictId));
        } else if (result.error === 'reserved') {
          setError(reservedMessage());
        } else {
          setError('Could not rebind that shortcut');
        }
        return;
      }

      setListeningId(null);
      setError(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listeningId, setShortcut]);

  return (
    <div>
      <p className={styles.hint}>
        Click a shortcut, then press the new keys. Space and Escape stay reserved. Conflicts with an
        existing binding are refused.
      </p>
      {REBINDABLE_SHORTCUT_IDS.map((id) => (
        <div key={id} className={styles.row}>
          <div className={styles.label}>{SHORTCUT_META[id].label}</div>
          <button
            type="button"
            className={`${styles.capture} ${listeningId === id ? styles.listening : ''}`}
            aria-label={
              listeningId === id
                ? `Press new shortcut for ${SHORTCUT_META[id].label}`
                : `Rebind ${SHORTCUT_META[id].label}`
            }
            onClick={() => {
              setListeningId(id);
              setError(null);
            }}
          >
            {listeningId === id ? 'Press keys…' : formatChordDisplay(shortcuts[id], true)}
          </button>
        </div>
      ))}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            resetShortcuts();
            setListeningId(null);
            setError(null);
          }}
        >
          Reset shortcuts
        </button>
      </div>
    </div>
  );
}
