import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../store';
import styles from './EditLinkTargetDialog.module.css';
import { basename } from '../utils/path';
import { createFocusTrap } from '../utils/accessibility';
import { readLinkInfo, setLinkTarget, linkTypeLabel, type LinkInfo } from '../utils/links';
import { reportError } from '../utils/errorReporter';

interface EditLinkTargetDialogProps {
  open: boolean;
  /** The symlink or junction being edited. */
  file: FileEntry;
  onClose: () => void;
  /** Called after the target is changed so the listing can refresh. */
  onSuccess: () => void | Promise<void>;
}

/**
 * EditLinkTargetDialog - Repoint a symbolic link or Windows junction.
 *
 * The link keeps its kind: a junction stays a junction, so the target rules
 * differ (junctions need an absolute directory) and are surfaced up front.
 */
export function EditLinkTargetDialog({
  open,
  file,
  onClose,
  onSuccess,
}: EditLinkTargetDialogProps) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const trap = createFocusTrap(dialogRef.current);
    focusTrapRef.current = trap;
    trap.activate();
    return () => {
      focusTrapRef.current = null;
      trap.deactivate();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInfo(null);
    setError(null);
    readLinkInfo(file.path)
      .then((loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        setTarget(loaded.target);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError ?? 'Unknown error')
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, file.path]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      const trimmed = target.trim();
      if (!trimmed) {
        setError('Enter a target path');
        return;
      }

      setSaving(true);
      setError(null);
      try {
        await setLinkTarget(file.path, trimmed);
        await onSuccess();
        onClose();
      } catch (saveError) {
        const message =
          saveError instanceof Error ? saveError.message : String(saveError ?? 'Unknown error');
        setError(message);
        reportError('Edit link target failed', saveError, { context: { path: file.path } });
      } finally {
        setSaving(false);
      }
    },
    [target, file.path, onSuccess, onClose]
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  const name = file.name || basename(file.path);
  const isJunction = info?.kind === 'junction' || Boolean(file.is_junction);

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-link-target-title"
        onKeyDown={(event) => focusTrapRef.current?.handleKeyDown(event)}
      >
        <h2 id="edit-link-target-title" className={styles.title}>
          Edit Link Target
        </h2>
        <p className={styles.subtitle}>
          {linkTypeLabel(file)}: <span className={styles.linkName}>{name}</span>
        </p>
        <form onSubmit={handleSubmit}>
          <div className={styles.inputContainer}>
            <label className={styles.inputLabel} htmlFor="edit-link-target-input">
              Target path
            </label>
            <input
              id="edit-link-target-input"
              data-autofocus
              type="text"
              className={`${styles.input} ${error ? styles.inputError : ''}`}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setError(null);
              }}
              placeholder={isJunction ? 'C:\\absolute\\folder' : 'Path the link points to'}
              disabled={!info || saving}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {error && <span className={styles.errorText}>{error}</span>}
            {info && !error && (
              <span className={styles.hint}>
                {info.target_exists ? (
                  <>Currently resolves to {info.resolved_target}</>
                ) : (
                  <span className={styles.warningText}>
                    Currently broken: {info.resolved_target} does not exist
                  </span>
                )}
              </span>
            )}
            {isJunction && (
              <span className={styles.hint}>
                A junction target must be an absolute path to an existing folder.
              </span>
            )}
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={styles.saveButton}
              disabled={!info || saving || !target.trim() || target.trim() === info?.target}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default EditLinkTargetDialog;
