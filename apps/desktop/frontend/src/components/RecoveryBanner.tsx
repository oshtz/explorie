/**
 * Recovery Banner Component
 *
 * Displays a banner when crash recovery is available, allowing users
 * to restore their previous session or dismiss the prompt.
 */

import React from 'react';
import { Icon } from './Icon';
import styles from './RecoveryBanner.module.css';

interface RecoveryBannerProps {
  /** Number of tabs that can be recovered */
  tabCount: number;
  /** Last save timestamp */
  lastSaveAt: Date | null;
  /** Last path user was viewing */
  lastPath: string | null;
  /** Callback to accept recovery */
  onRecover: () => void;
  /** Callback to dismiss recovery */
  onDismiss: () => void;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return date.toLocaleDateString();
}

function getPathName(path: string | null): string {
  if (!path) return '';
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || parts[parts.length - 2] || path;
}

export function RecoveryBanner({
  tabCount,
  lastSaveAt,
  lastPath,
  onRecover,
  onDismiss,
}: RecoveryBannerProps): React.ReactElement {
  const timeAgo = lastSaveAt ? formatTimeAgo(lastSaveAt) : null;
  const pathName = getPathName(lastPath);

  return (
    <div className={styles.banner}>
      <div className={styles.icon}>
        <Icon name="refresh-cw" />
      </div>
      <div className={styles.content}>
        <div className={styles.title}>Restore previous session?</div>
        <div className={styles.details}>
          {tabCount > 0 && (
            <span className={styles.detail}>
              {tabCount} tab{tabCount !== 1 ? 's' : ''}
            </span>
          )}
          {pathName && <span className={styles.detail}>Last: {pathName}</span>}
          {timeAgo && <span className={styles.detail}>Saved {timeAgo}</span>}
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.dismissButton} onClick={onDismiss} title="Don't restore">
          Dismiss
        </button>
        <button
          className={styles.recoverButton}
          onClick={onRecover}
          title="Restore previous session"
        >
          <Icon name="check" />
          Restore
        </button>
      </div>
    </div>
  );
}

export default RecoveryBanner;
