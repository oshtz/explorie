import React from 'react';
import styles from './InfoBox.module.css';
import { Icon } from './Icon';

export function InfoBox({ onClose }: { onClose?: () => void }) {
  return (
    <div className={styles.container}>
      <div className={styles.iconWrap}>
        <Icon name="list" size={14} className="pixelIcon-accent" />
      </div>
      <div className={styles.content}>
        <div className={styles.title}>Welcome to explorie</div>
        <div className={styles.subtitle}>This is a placeholder. Feature disabled for now.</div>
      </div>
      <button className={styles.button} onClick={onClose}>
        Got it
      </button>
    </div>
  );
}
