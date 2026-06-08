import React from 'react';
import styles from './UpdateStatus.module.css';
import { useUpdateStore } from '../updateStore';

const statusLabels: Record<string, string> = {
  idle: 'Idle',
  checking: 'Checking for updates',
  available: 'Update available',
  downloading: 'Downloading update',
  ready: 'Ready to install',
  installing: 'Installing update',
  'up-to-date': 'Up to date',
  error: 'Error',
};

export function UpdateStatus() {
  const {
    currentVersion,
    status,
    updateInfo,
    updatePath,
    error,
    lastCheckedAt,
    loadCurrentVersion,
    checkNow,
    downloadNow,
    installNow,
  } = useUpdateStore();

  React.useEffect(() => {
    loadCurrentVersion().catch(() => undefined);
  }, [loadCurrentVersion]);

  const busy = status === 'checking' || status === 'downloading' || status === 'installing';
  const lastCheckedLabel = lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : 'Never';

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <div className={styles.label}>Current version</div>
        <div className={styles.value}>{currentVersion ?? 'Unknown'}</div>
      </div>
      <div className={styles.row}>
        <div className={styles.label}>Status</div>
        <div className={styles.status}>{statusLabels[status] ?? status}</div>
      </div>
      <div className={styles.row}>
        <div className={styles.label}>Last checked</div>
        <div className={styles.value}>{lastCheckedLabel}</div>
      </div>
      <div className={styles.row}>
        <div className={styles.label}>Actions</div>
        <div className={styles.actions}>
          <button type="button" onClick={() => checkNow()} disabled={busy}>
            {status === 'checking' ? 'Checking...' : 'Check for updates'}
          </button>
          {status === 'available' && (
            <button type="button" onClick={() => downloadNow()} disabled={busy}>
              Download update
            </button>
          )}
          {status === 'ready' && updatePath && (
            <button type="button" onClick={() => installNow()} disabled={busy}>
              Install update
            </button>
          )}
        </div>
      </div>
      {updateInfo && (
        <div className={styles.row}>
          <div className={styles.label}>Latest version</div>
          <div className={styles.value}>{updateInfo.version}</div>
        </div>
      )}
      {updateInfo?.notes && (
        <div className={styles.row}>
          <div className={styles.label}>Release notes</div>
          <div className={styles.notes}>{updateInfo.notes}</div>
        </div>
      )}
      {error && (
        <div className={styles.row}>
          <div className={styles.label}>Error</div>
          <div className={styles.error}>{error}</div>
        </div>
      )}
    </div>
  );
}
