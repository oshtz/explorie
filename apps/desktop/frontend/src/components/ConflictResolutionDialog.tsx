import React, { useEffect, useRef, useCallback, useState } from 'react';
import styles from './ConflictResolutionDialog.module.css';
import { Icon } from './Icon';
import { formatBytes } from '../operationQueueStore';
import { formatLocalDateTime } from '../utils/date';
import type { ConflictAction, ConflictInfo } from '../conflictResolutionStore';

export type { ConflictAction, ConflictInfo };

export interface ConflictResolutionDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Information about the conflict */
  conflict: ConflictInfo | null;
  /** Operation type (copy or move) */
  operationType: 'copy' | 'move';
  /** Current conflict index (1-based) */
  currentIndex?: number;
  /** Total number of conflicts */
  totalConflicts?: number;
  /** Called when user selects an action */
  onResolve: (action: ConflictAction, applyToAll: boolean) => void;
  /** Called when user cancels the operation */
  onCancel: () => void;
}

/**
 * Dialog for resolving file conflicts during copy/move operations.
 * Shows source and destination file info and allows user to choose how to handle the conflict.
 */
export function ConflictResolutionDialog({
  open,
  conflict,
  operationType,
  currentIndex = 1,
  totalConflicts = 1,
  onResolve,
  onCancel,
}: ConflictResolutionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [applyToAll, setApplyToAll] = useState(false);

  // Reset applyToAll when dialog opens with a new conflict
  useEffect(() => {
    if (open) {
      setApplyToAll(false);
    }
  }, [open, conflict?.sourcePath]);

  // Handle escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  // Handle click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onCancel();
      }
    },
    [onCancel]
  );

  const handleAction = useCallback(
    (action: ConflictAction) => {
      onResolve(action, applyToAll);
    },
    [onResolve, applyToAll]
  );

  const formatModified = (date: Date | number | string | undefined): string => {
    if (!date) return 'Unknown';
    try {
      return formatLocalDateTime(date);
    } catch {
      return 'Unknown';
    }
  };

  const formatSize = (size: number | undefined, isDir: boolean): string => {
    if (isDir) return 'Folder';
    if (size === undefined) return 'Unknown size';
    return formatBytes(size);
  };

  if (!open || !conflict) return null;

  const isDir = conflict.sourceIsDir || conflict.destIsDir;
  const itemType = isDir ? 'folder' : 'file';
  const actionVerb = operationType === 'copy' ? 'copying' : 'moving';

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-dialog-title"
      >
        <div className={styles.header}>
          <div className={styles.headerContent}>
            <span className={styles.warningIcon}>
              <Icon name="alert" size={18} />
            </span>
            <h2 id="conflict-dialog-title" className={styles.title}>
              {itemType === 'folder' ? 'Folder' : 'File'} Already Exists
            </h2>
          </div>
          {totalConflicts > 1 && (
            <span className={styles.conflictCounter}>
              {currentIndex} of {totalConflicts}
            </span>
          )}
        </div>

        <div className={styles.content}>
          <p className={styles.message}>
            A {itemType} named <strong>"{conflict.destName}"</strong> already exists in the
            destination. What would you like to do?
          </p>

          <div className={styles.fileComparison}>
            {/* Source file info */}
            <div className={styles.fileInfo}>
              <div className={styles.fileInfoHeader}>
                <Icon name={isDir ? 'folder' : 'file'} size={16} />
                <span>Source ({actionVerb} from)</span>
              </div>
              <div className={styles.fileDetails}>
                <div className={styles.fileName} title={conflict.sourcePath}>
                  {conflict.sourceName}
                </div>
                <div className={styles.fileMeta}>
                  <span>{formatSize(conflict.sourceSize, conflict.sourceIsDir)}</span>
                  <span className={styles.separator}>•</span>
                  <span>{formatModified(conflict.sourceModified)}</span>
                </div>
              </div>
            </div>

            <div className={styles.arrow}>
              <Icon name="chevron-right" size={20} />
            </div>

            {/* Destination file info */}
            <div className={styles.fileInfo}>
              <div className={styles.fileInfoHeader}>
                <Icon name={isDir ? 'folder' : 'file'} size={16} />
                <span>Existing {itemType}</span>
              </div>
              <div className={styles.fileDetails}>
                <div className={styles.fileName} title={conflict.destPath}>
                  {conflict.destName}
                </div>
                <div className={styles.fileMeta}>
                  <span>{formatSize(conflict.destSize, conflict.destIsDir)}</span>
                  <span className={styles.separator}>•</span>
                  <span>{formatModified(conflict.destModified)}</span>
                </div>
              </div>
            </div>
          </div>

          {totalConflicts > 1 && (
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className={styles.checkbox}
              />
              <span>Apply this action to all {totalConflicts} conflicts</span>
            </label>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.actionButtons}>
            <button
              className={styles.actionButton}
              onClick={() => handleAction('skip')}
              title="Skip this file and continue with the next"
            >
              <Icon name="x" size={14} />
              <span>Skip</span>
            </button>
            <button
              className={`${styles.actionButton} ${styles.replaceButton}`}
              onClick={() => handleAction('replace')}
              title="Replace the existing file with the new one"
            >
              <Icon name="refresh" size={14} />
              <span>Replace</span>
            </button>
            <button
              className={styles.actionButton}
              onClick={() => handleAction('keepBoth')}
              title="Keep both files by adding a number to the new file's name"
            >
              <Icon name="copy" size={14} />
              <span>Keep Both</span>
            </button>
          </div>
          <button className={styles.cancelButton} onClick={onCancel}>
            Cancel All
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConflictResolutionDialog;
