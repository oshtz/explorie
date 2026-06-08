import React, { useEffect, useRef, useCallback } from 'react';
import styles from './ConfirmDialog.module.css';
import { Icon } from './Icon';

export interface ConfirmDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Title of the dialog */
  title: string;
  /** Message to display */
  message: string;
  /** Text for the confirm button */
  confirmLabel?: string;
  /** Text for the cancel button */
  cancelLabel?: string;
  /** Whether the action is destructive (changes button color) */
  destructive?: boolean;
  /** Called when user confirms */
  onConfirm: () => void;
  /** Called when user cancels or closes the dialog */
  onCancel: () => void;
  /** Optional: show "Don't ask again" checkbox */
  showDontAskAgain?: boolean;
  /** Optional: callback when "Don't ask again" changes */
  onDontAskAgainChange?: (checked: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  showDontAskAgain = false,
  onDontAskAgainChange,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [dontAskAgain, setDontAskAgain] = React.useState(false);

  // Focus the confirm button when dialog opens
  useEffect(() => {
    if (open && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [open]);

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

  const handleConfirm = useCallback(() => {
    if (showDontAskAgain && dontAskAgain) {
      onDontAskAgainChange?.(true);
    }
    onConfirm();
  }, [onConfirm, showDontAskAgain, dontAskAgain, onDontAskAgainChange]);

  const handleDontAskAgainChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDontAskAgain(e.target.checked);
  }, []);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        <div className={styles.header}>
          <h2 id="confirm-dialog-title" className={styles.title}>
            {destructive && (
              <span className={styles.warningIcon}>
                <Icon name="alert" size={16} />
              </span>
            )}
            {title}
          </h2>
        </div>

        <div className={styles.content}>
          <p id="confirm-dialog-message" className={styles.message}>
            {message}
          </p>

          {showDontAskAgain && (
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={handleDontAskAgainChange}
                className={styles.checkbox}
              />
              <span>Don't ask again</span>
            </label>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelButton} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            className={`${styles.confirmButton} ${destructive ? styles.destructive : ''}`}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
