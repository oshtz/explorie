import React from 'react';
import styles from './ViewModeToggle.module.css';

export type ViewMode = 'list' | 'column' | 'grid';

interface ViewModeToggleProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

export function ViewModeToggle({ viewMode, setViewMode }: ViewModeToggleProps) {
  return (
    <div className={styles.container}>
      <label className={styles.label}>View mode:</label>
      <button
        onClick={() => setViewMode('list')}
        className={viewMode === 'list' ? styles.buttonActive : styles.button}
      >
        List
      </button>
      <button
        onClick={() => setViewMode('column')}
        className={viewMode === 'column' ? styles.buttonActive : styles.button}
      >
        Column
      </button>
      <button
        onClick={() => setViewMode('grid')}
        className={viewMode === 'grid' ? styles.buttonActive : styles.button}
      >
        Grid
      </button>
    </div>
  );
}
