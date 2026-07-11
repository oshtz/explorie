import React, { useCallback, useState } from 'react';
import { Icon } from './Icon';
import type { FileOperation } from '../operationQueueStore';
import { useOperationQueueStore, formatBytes } from '../operationQueueStore';
import { useFileStore } from '../store';
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
    case 'cancelled':
      return styles.operationCancelled;
    default:
      return '';
  }
}

// Single operation item component
function OperationItem({ operation }: { operation: FileOperation }) {
  const cancelOperation = useOperationQueueStore((s) => s.cancelOperation);
  const removeOperation = useOperationQueueStore((s) => s.removeOperation);

  const rawProgress =
    operation.totalBytes > 0
      ? (operation.processedBytes / operation.totalBytes) * 100
      : operation.totalItems > 0
        ? (operation.processedItems / operation.totalItems) * 100
        : 0;
  const progress = Math.min(
    100,
    Math.max(0, Number.isFinite(rawProgress) ? Math.round(rawProgress) : 0)
  );

  const isActive = operation.status === 'running';
  const canCancel = isActive;
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
        <span
          className={styles.operationStatus}
          role={operation.status === 'failed' ? 'alert' : undefined}
        >
          {operation.status === 'running'
            ? 'In progress'
            : operation.status === 'completed'
              ? 'Completed'
              : operation.status === 'cancelled'
                ? 'Cancelled'
                : 'Failed'}
        </span>
        <div className={styles.operationActions}>
          {canCancel && (
            <button
              className={styles.actionButton}
              onClick={() => cancelOperation(operation.id)}
              title="Cancel"
              aria-label={`Cancel ${operation.type} operation`}
            >
              <Icon name="x" size={12} />
            </button>
          )}
          {canRemove && (
            <button
              className={styles.actionButton}
              onClick={() => removeOperation(operation.id)}
              title="Remove"
              aria-label={`Remove ${operation.type} operation`}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className={styles.progressSection}>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-label={`${operation.type} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <div className={styles.progressStats}>
            <span className={styles.progressPercent}>{progress}%</span>
          </div>
        </div>
      )}

      {/* Completed progress bar */}
      {operation.status === 'completed' && (
        <div className={styles.progressSection}>
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-label={`${operation.type} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={100}
          >
            <div className={styles.progressFill} style={{ width: '100%' }} />
          </div>
          <div className={styles.progressStats}>
            <span className={styles.progressPercent}>Completed</span>
            <span>{formatBytes(operation.processedBytes)}</span>
          </div>
        </div>
      )}

      {operation.status === 'cancelled' && (
        <div className={styles.progressStats}>
          <span className={styles.progressPercent}>Cancelled</span>
          <span>{formatBytes(operation.processedBytes)}</span>
        </div>
      )}

      {/* Current file */}
      {operation.currentItem && operation.status === 'running' && (
        <div className={styles.currentFile}>{operation.currentItem}</div>
      )}

      {/* Error section */}
      {operation.error && operation.status === 'failed' && (
        <div className={styles.errorSection} role="alert">
          <div className={styles.errorHeader}>
            <Icon name="warning-box" size={12} />
            Operation failed
          </div>
          <div className={styles.errorText}>{operation.error}</div>
          <button className={styles.dismissButton} onClick={() => removeOperation(operation.id)}>
            Dismiss
          </button>
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
  const showStatusBar = useFileStore((s) => s.showStatusBar);
  const bottom = showStatusBar ? 'calc(var(--command-size-sm) + 12px)' : '12px';

  const [minimized, setMinimized] = useState(false);

  const activeCount = operations.filter((o) => o.status === 'running').length;
  const finishedCount = operations.length - activeCount;
  const failedCount = operations.filter((o) => o.status === 'failed').length;

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
      <button
        type="button"
        className={styles.floatingIndicator}
        style={{ bottom }}
        onClick={() => setMinimized(false)}
        aria-label={`Expand operations: ${activeCount} in progress`}
      >
        <div className={styles.floatingSpinner} />
        <span className={styles.floatingText}>
          {activeCount} operation{activeCount !== 1 ? 's' : ''} in progress
        </span>
      </button>
    );
  }

  return (
    <section
      className={`${styles.panel} ${minimized ? styles.minimized : ''}`}
      style={{ bottom }}
      aria-label="File operations"
    >
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
        {activeCount === 0 && failedCount > 0 && (
          <span className={`${styles.statusBadge} ${styles.statusFailed}`} role="alert">
            {failedCount} failed
          </span>
        )}
        {activeCount === 0 && failedCount === 0 && finishedCount > 0 && (
          <span className={`${styles.statusBadge} ${styles.statusComplete}`}>Finished</span>
        )}
        <div className={styles.headerActions}>
          {finishedCount > 0 && (
            <button
              className={styles.headerButton}
              onClick={clearCompleted}
              title="Clear finished"
              aria-label="Clear finished operations"
            >
              <Icon name="check" size={12} />
            </button>
          )}
          <button
            className={styles.headerButton}
            onClick={handleToggleMinimize}
            title={minimized ? 'Expand' : 'Minimize'}
            aria-label={minimized ? 'Expand operations' : 'Minimize operations'}
          >
            <Icon name={minimized ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
          {activeCount === 0 && (
            <button
              className={styles.headerButton}
              onClick={handleClose}
              title="Close"
              aria-label="Close operations"
            >
              <Icon name="x" size={12} />
            </button>
          )}
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
    </section>
  );
}

export default OperationProgress;
