import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './SecureDeleteDialog.module.css';
import { Icon } from './Icon';
import type { FileEntry } from '../store/types';
import { formatBytes } from '../operationQueueStore';
import { isTrashPath, getTrashPath } from '../utils/trash';

export interface SecureDeleteDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Files to delete */
  files: FileEntry[];
  /** Called when user confirms deletion */
  onConfirm: (permanent: boolean) => void;
  /** Called when user cancels or closes the dialog */
  onCancel: () => void;
  /** Optional: show "Don't ask again" checkbox */
  showDontAskAgain?: boolean;
  /** Optional: callback when "Don't ask again" changes */
  onDontAskAgainChange?: (checked: boolean) => void;
}

interface DirInfo {
  path: string;
  itemCount: number;
  totalSize: number;
  loading: boolean;
  error: string | null;
}

export function SecureDeleteDialog({
  open,
  files,
  onConfirm,
  onCancel,
  showDontAskAgain = false,
  onDontAskAgainChange,
}: SecureDeleteDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [dirInfoMap, setDirInfoMap] = useState<Map<string, DirInfo>>(new Map());
  const [trashPath, setTrashPath] = useState<string | null>(null);

  // Determine if any files are from trash (permanent delete only)
  const filesInTrash = useMemo(() => {
    if (!trashPath) return [];
    return files.filter((f) => isTrashPath(f.path, trashPath));
  }, [files, trashPath]);

  const allInTrash = filesInTrash.length === files.length && files.length > 0;
  const someInTrash = filesInTrash.length > 0 && filesInTrash.length < files.length;

  // Get trash path on mount
  useEffect(() => {
    if (!open) return;
    getTrashPath()
      .then(setTrashPath)
      .catch(() => setTrashPath(null));
  }, [open]);

  // Load directory info for non-empty folders
  useEffect(() => {
    if (!open) return;

    const dirs = files.filter((f) => f.is_dir);
    if (dirs.length === 0) return;

    const loadDirInfo = async (file: FileEntry) => {
      setDirInfoMap((prev) => {
        const next = new Map(prev);
        next.set(file.path, {
          path: file.path,
          itemCount: 0,
          totalSize: 0,
          loading: true,
          error: null,
        });
        return next;
      });

      try {
        // Get directory contents count and size
        const result = await invoke<{ count: number; size: number }>('get_dir_info', {
          path: file.path,
        });
        setDirInfoMap((prev) => {
          const next = new Map(prev);
          next.set(file.path, {
            path: file.path,
            itemCount: result.count,
            totalSize: result.size,
            loading: false,
            error: null,
          });
          return next;
        });
      } catch (e) {
        // Fallback: just show as directory without count
        setDirInfoMap((prev) => {
          const next = new Map(prev);
          next.set(file.path, {
            path: file.path,
            itemCount: -1,
            totalSize: 0,
            loading: false,
            error: e instanceof Error ? e.message : 'Failed to get info',
          });
          return next;
        });
      }
    };

    dirs.forEach(loadDirInfo);

    return () => {
      setDirInfoMap(new Map());
    };
  }, [open, files]);

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

  const handleMoveToTrash = useCallback(() => {
    if (showDontAskAgain && dontAskAgain) {
      onDontAskAgainChange?.(true);
    }
    onConfirm(false);
  }, [onConfirm, showDontAskAgain, dontAskAgain, onDontAskAgainChange]);

  const handlePermanentDelete = useCallback(() => {
    if (showDontAskAgain && dontAskAgain) {
      onDontAskAgainChange?.(true);
    }
    onConfirm(true);
  }, [onConfirm, showDontAskAgain, dontAskAgain, onDontAskAgainChange]);

  const handleDontAskAgainChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDontAskAgain(e.target.checked);
  }, []);

  // Calculate totals
  const totalSize = useMemo(() => {
    let size = 0;
    for (const file of files) {
      if (file.is_dir) {
        const info = dirInfoMap.get(file.path);
        if (info && !info.loading && info.totalSize > 0) {
          size += info.totalSize;
        }
      } else {
        size += file.size || 0;
      }
    }
    return size;
  }, [files, dirInfoMap]);

  const totalItems = useMemo(() => {
    let count = files.length;
    for (const file of files) {
      if (file.is_dir) {
        const info = dirInfoMap.get(file.path);
        if (info && !info.loading && info.itemCount > 0) {
          count += info.itemCount;
        }
      }
    }
    return count;
  }, [files, dirInfoMap]);

  const hasNonEmptyDirs = useMemo(() => {
    return Array.from(dirInfoMap.values()).some((info) => !info.loading && info.itemCount > 0);
  }, [dirInfoMap]);

  const isLoading = useMemo(() => {
    return Array.from(dirInfoMap.values()).some((info) => info.loading);
  }, [dirInfoMap]);

  if (!open) return null;

  const fileCount = files.filter((f) => !f.is_dir).length;
  const dirCount = files.filter((f) => f.is_dir).length;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="secure-delete-title"
        aria-describedby="secure-delete-desc"
      >
        <div className={styles.header}>
          <h2 id="secure-delete-title" className={styles.title}>
            <span className={styles.warningIcon}>
              <Icon name="alert" size={18} />
            </span>
            {allInTrash ? 'Permanently Delete' : 'Delete Items'}
          </h2>
        </div>

        <div className={styles.content}>
          {/* Summary section */}
          <div className={styles.summary}>
            <div className={styles.summaryRow}>
              <span className={styles.summaryLabel}>Items selected:</span>
              <span className={styles.summaryValue}>
                {files.length} {files.length === 1 ? 'item' : 'items'}
                {fileCount > 0 && dirCount > 0 && (
                  <span className={styles.summaryDetail}>
                    ({fileCount} {fileCount === 1 ? 'file' : 'files'}, {dirCount}{' '}
                    {dirCount === 1 ? 'folder' : 'folders'})
                  </span>
                )}
              </span>
            </div>
            {hasNonEmptyDirs && (
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Total items:</span>
                <span className={styles.summaryValue}>
                  {isLoading ? (
                    <span className={styles.loading}>Calculating...</span>
                  ) : (
                    `${totalItems} items (including folder contents)`
                  )}
                </span>
              </div>
            )}
            {totalSize > 0 && (
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Total size:</span>
                <span className={styles.summaryValue}>
                  {isLoading ? (
                    <span className={styles.loading}>Calculating...</span>
                  ) : (
                    formatBytes(totalSize)
                  )}
                </span>
              </div>
            )}
          </div>

          {/* File list */}
          <div className={styles.fileList}>
            {files.slice(0, 10).map((file) => {
              const name = file.name || file.path.split(/[/\\]/).pop() || file.path;
              const info = file.is_dir ? dirInfoMap.get(file.path) : null;
              const inTrash = trashPath ? isTrashPath(file.path, trashPath) : false;

              return (
                <div key={file.id || file.path} className={styles.fileItem}>
                  <Icon name={file.is_dir ? 'folder' : 'file'} size={14} />
                  <span className={styles.fileName}>{name}</span>
                  {file.is_dir && info && !info.loading && info.itemCount > 0 && (
                    <span className={styles.itemCount}>
                      ({info.itemCount} {info.itemCount === 1 ? 'item' : 'items'})
                    </span>
                  )}
                  {file.is_dir && info?.loading && (
                    <span className={styles.itemCount}>(loading...)</span>
                  )}
                  {!file.is_dir && file.size !== undefined && file.size > 0 && (
                    <span className={styles.fileSize}>{formatBytes(file.size)}</span>
                  )}
                  {inTrash && <span className={styles.trashBadge}>In Trash</span>}
                </div>
              );
            })}
            {files.length > 10 && (
              <div className={styles.moreItems}>...and {files.length - 10} more items</div>
            )}
          </div>

          {/* Warnings */}
          {hasNonEmptyDirs && !allInTrash && (
            <div className={styles.warning}>
              <Icon name="alert" size={14} />
              <span>
                Non-empty folders will be deleted recursively, including all their contents.
              </span>
            </div>
          )}

          {someInTrash && (
            <div className={styles.warning}>
              <Icon name="alert" size={14} />
              <span>
                {filesInTrash.length} {filesInTrash.length === 1 ? 'item is' : 'items are'} already
                in Trash and will be permanently deleted.
              </span>
            </div>
          )}

          {/* Info about trash */}
          {!allInTrash && (
            <p id="secure-delete-desc" className={styles.description}>
              Items moved to Trash can be restored later. Use "Delete Permanently" to bypass Trash.
            </p>
          )}

          {allInTrash && (
            <p id="secure-delete-desc" className={styles.descriptionWarning}>
              These items are already in Trash. Deleting them will remove them permanently and
              cannot be undone.
            </p>
          )}

          {showDontAskAgain && (
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={handleDontAskAgainChange}
                className={styles.checkbox}
              />
              <span>Don't ask again for simple deletes</span>
            </label>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          {!allInTrash && (
            <button
              ref={confirmButtonRef}
              className={styles.trashButton}
              onClick={handleMoveToTrash}
              disabled={isLoading}
            >
              <Icon name="trash" size={14} />
              Move to Trash
            </button>
          )}
          <button
            ref={allInTrash ? confirmButtonRef : undefined}
            className={styles.deleteButton}
            onClick={handlePermanentDelete}
            disabled={isLoading}
          >
            <Icon name="x" size={14} />
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
}

export default SecureDeleteDialog;
