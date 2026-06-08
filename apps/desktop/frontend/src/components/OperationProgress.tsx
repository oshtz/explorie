import React, { useCallback, useState } from 'react';
import { Icon } from './Icon';
import type { FileOperation } from '../operationQueueStore';
import {
  useOperationQueueStore,
  formatBytes,
  formatTimeRemaining,
  formatSpeed,
} from '../operationQueueStore';
import styles from './OperationProgress.module.css';

// Helper to get icon for operation type
function getOperationIcon(type: FileOperation['type']): string {
  switch (type) {
    case 'copy':
      return 'copy';
    case 'move':
      return 'move';
    case 'delete':
      return 'trash';
    case 'compress':
      return 'archive';
    case 'extract':
      return 'unarchive';
    default:
      return 'file';
  }
}

// Helper to get status class
function getStatusClass(status: FileOperation['status']): string {
  switch (status) {
    case 'running':
      return styles.operationRunning;
    case 'completed':
      return styles.operationCompleted;
    case 'failed':
      return styles.operationFailed;
    case 'paused':
      return styles.operationPaused;
    default:
      return '';
  }
}

// Single operation item component
function OperationItem({ operation }: { operation: FileOperation }) {
  const pauseOperation = useOperationQueueStore((s) => s.pauseOperation);
  const resumeOperation = useOperationQueueStore((s) => s.resumeOperation);
  const cancelOperation = useOperationQueueStore((s) => s.cancelOperation);
  const retryOperation = useOperationQueueStore((s) => s.retryOperation);
  const removeOperation = useOperationQueueStore((s) => s.removeOperation);

  const progress =
    operation.totalBytes > 0
      ? Math.round((operation.processedBytes / operation.totalBytes) * 100)
      : operation.totalItems > 0
        ? Math.round((operation.processedItems / operation.totalItems) * 100)
        : 0;

  const isActive = operation.status === 'running' || operation.status === 'paused';
  const canPause = operation.status === 'running';
  const canResume = operation.status === 'paused';
  const canCancel = isActive || operation.status === 'pending';
  const canRetry = operation.status === 'failed';
  const canRemove =
    operation.status === 'completed' ||
    operation.status === 'cancelled' ||
    operation.status === 'failed';

  return (
    <div className={`${styles.operation} ${getStatusClass(operation.status)}`}>
      <div className={styles.operationHeader}>
        <div className={styles.operationIcon}>
          <Icon name={getOperationIcon(operation.type)} size={14} />
        </div>
        <div className={styles.operationInfo}>
          <div className={styles.operationType}>{operation.type}</div>
          <div className={styles.operationDetails}>
            {operation.totalItems} item{operation.totalItems !== 1 ? 's' : ''}
            {operation.destinationPath && ` → ${operation.destinationPath.split(/[/\\]/).pop()}`}
          </div>
        </div>
        <div className={styles.operationActions}>
          {canPause && (
            <button
              className={styles.actionButton}
              onClick={() => pauseOperation(operation.id)}
              title="Pause"
            >
              <Icon name="pause" size={12} />
            </button>
          )}
          {canResume && (
            <button
              className={styles.actionButton}
              onClick={() => resumeOperation(operation.id)}
              title="Resume"
            >
              <Icon name="play" size={12} />
            </button>
          )}
          {canCancel && (
            <button
              className={styles.actionButton}
              onClick={() => cancelOperation(operation.id)}
              title="Cancel"
            >
              <Icon name="x" size={12} />
            </button>
          )}
          {canRetry && (
            <button
              className={styles.actionButton}
              onClick={() => retryOperation(operation.id)}
              title="Retry"
            >
              <Icon name="reload" size={12} />
            </button>
          )}
          {canRemove && (
            <button
              className={styles.actionButton}
              onClick={() => removeOperation(operation.id)}
              title="Remove"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(isActive || operation.status === 'pending') && (
        <div className={styles.progressSection}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <div className={styles.progressStats}>
            <span className={styles.progressPercent}>{progress}%</span>
            <div className={styles.progressSpeed}>
              {operation.speed !== undefined && operation.speed > 0 && (
                <span>{formatSpeed(operation.speed)}</span>
              )}
              {operation.estimatedTimeRemaining !== undefined &&
                operation.estimatedTimeRemaining > 0 && (
                  <span>{formatTimeRemaining(operation.estimatedTimeRemaining)} left</span>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Completed progress bar */}
      {operation.status === 'completed' && (
        <div className={styles.progressSection}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: '100%' }} />
          </div>
          <div className={styles.progressStats}>
            <span className={styles.progressPercent}>Complete</span>
            <span>{formatBytes(operation.processedBytes)}</span>
          </div>
        </div>
      )}

      {/* Current file */}
      {operation.currentItem && operation.status === 'running' && (
        <div className={styles.currentFile}>{operation.currentItem}</div>
      )}

      {/* Error section with retry option */}
      {operation.error && operation.status === 'failed' && (
        <div className={styles.errorSection}>
          <div className={styles.errorHeader}>
            <Icon name="warning-box" size={12} />
            Operation failed
          </div>
          <div className={styles.errorText}>{operation.error}</div>
          <div className={styles.errorActions}>
            <button className={styles.retryButton} onClick={() => retryOperation(operation.id)}>
              <Icon name="reload" size={10} />
              Retry
            </button>
            <button className={styles.dismissButton} onClick={() => removeOperation(operation.id)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Error message for non-failed states (like partial errors) */}
      {operation.error && operation.status !== 'failed' && (
        <div className={styles.errorMessage}>
          <Icon name="warning-box" size={12} />
          {operation.error}
        </div>
      )}
    </div>
  );
}

// Main panel component
export function OperationProgress() {
  const operations = useOperationQueueStore((s) => s.operations);
  const showProgressPanel = useOperationQueueStore((s) => s.showProgressPanel);
  const setShowProgressPanel = useOperationQueueStore((s) => s.setShowProgressPanel);
  const clearCompleted = useOperationQueueStore((s) => s.clearCompleted);

  const [minimized, setMinimized] = useState(false);

  const activeCount = operations.filter(
    (o) => o.status === 'running' || o.status === 'pending'
  ).length;
  const completedCount = operations.filter(
    (o) => o.status === 'completed' || o.status === 'cancelled'
  ).length;

  const handleClose = useCallback(() => {
    setShowProgressPanel(false);
  }, [setShowProgressPanel]);

  const handleToggleMinimize = useCallback(() => {
    setMinimized((prev) => !prev);
  }, []);

  // Don't show if no operations and panel is not forced open
  if (!showProgressPanel || operations.length === 0) {
    return null;
  }

  // Show floating indicator if minimized and has active operations
  if (minimized && activeCount > 0) {
    return (
      <div className={styles.floatingIndicator} onClick={() => setMinimized(false)}>
        <div className={styles.floatingSpinner} />
        <span className={styles.floatingText}>
          {activeCount} operation{activeCount !== 1 ? 's' : ''} in progress
        </span>
      </div>
    );
  }

  return (
    <div className={`${styles.panel} ${minimized ? styles.minimized : ''}`}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <Icon name="loader" size={14} />
        </div>
        <span className={styles.headerTitle}>Operations</span>
        {activeCount > 0 && (
          <span className={`${styles.statusBadge} ${styles.statusRunning}`}>
            {activeCount} active
          </span>
        )}
        {activeCount === 0 && completedCount > 0 && (
          <span className={`${styles.statusBadge} ${styles.statusComplete}`}>Done</span>
        )}
        <div className={styles.headerActions}>
          {completedCount > 0 && (
            <button
              className={styles.headerButton}
              onClick={clearCompleted}
              title="Clear completed"
            >
              <Icon name="check" size={12} />
            </button>
          )}
          <button
            className={styles.headerButton}
            onClick={handleToggleMinimize}
            title={minimized ? 'Expand' : 'Minimize'}
          >
            <Icon name={minimized ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
          <button className={styles.headerButton} onClick={handleClose} title="Close">
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>

      {!minimized && (
        <div className={styles.body}>
          {operations.length === 0 ? (
            <div className={styles.empty}>No operations in progress</div>
          ) : (
            operations.map((op) => <OperationItem key={op.id} operation={op} />)
          )}
        </div>
      )}
    </div>
  );
}

export default OperationProgress;
