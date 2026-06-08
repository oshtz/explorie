import React, { useCallback } from 'react';
import styles from './TitleBar.module.css';
import { Icon } from './Icon';
import { getCurrentWindow } from '@tauri-apps/api/window';

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getTauriWindow() {
  if (!hasTauriInternals()) return null;
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function TitleBar() {
  const appWindow = getTauriWindow();

  // Manual drag handling for macOS compatibility
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      // Only start drag on left mouse button and not on interactive elements
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;

      e.preventDefault();
      void appWindow?.startDragging();
    },
    [appWindow]
  );

  return (
    <div className={styles.titleBar} onMouseDown={handleDragStart}>
      <div className={styles.left}>
        <span className={styles.appName}>explorie</span>
      </div>
      <div className={styles.spacer} />
      {appWindow && (
        <div className={styles.windowControls}>
          <button
            className={styles.windowButton}
            title="Minimize"
            onClick={() => appWindow.minimize()}
          >
            <Icon name="minus" />
          </button>
          <button
            className={styles.windowButton}
            title="Maximize/Restore"
            onClick={() => appWindow.toggleMaximize()}
          >
            <Icon name="frame" />
          </button>
          <button
            className={styles.windowButtonClose}
            title="Close"
            onClick={() => appWindow.close()}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}
