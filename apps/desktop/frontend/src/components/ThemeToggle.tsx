import React from 'react';
import styles from './ThemeToggle.module.css';

interface ThemeToggleProps {
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;
}

export function ThemeToggle({ theme, setTheme }: ThemeToggleProps) {
  return (
    <div className={styles.container}>
      <label className={styles.label}>Theme:</label>
      <button
        onClick={() => setTheme('dark')}
        className={`${theme === 'dark' ? styles.buttonActive : styles.button} ${styles.buttonFirst}`}
      >
        Dark
      </button>
      <button
        onClick={() => setTheme('light')}
        className={theme === 'light' ? styles.buttonActive : styles.button}
      >
        Light
      </button>
    </div>
  );
}
