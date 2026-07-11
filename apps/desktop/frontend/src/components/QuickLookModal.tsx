import React, { useEffect, useCallback, useId, useRef, useState } from 'react';
import type { FileEntry } from '../store';
import { FilePreviewer } from './FilePreviewer';
import { Icon } from './Icon';
import styles from './QuickLookModal.module.css';
import { formatLocalDateTime } from '../utils/date';
import { createFocusTrap } from '../utils/accessibility';

interface QuickLookModalProps {
  file: FileEntry;
  files: FileEntry[]; // All files in current directory for navigation
  onClose: () => void;
  onNavigate: (file: FileEntry) => void;
}

/**
 * QuickLookModal - Full-screen preview modal triggered by spacebar
 * Supports:
 * - Escape to close
 * - Arrow keys to navigate between files
 * - Click outside to close
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${Number(value.toFixed(value >= 10 || index === 0 ? 0 : 1))} ${units[index]}`;
}

export function QuickLookModal({ file, files, onClose, onNavigate }: QuickLookModalProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!modalRef.current) return;
    const trap = createFocusTrap(modalRef.current);
    focusTrapRef.current = trap;
    trap.activate();
    return () => {
      focusTrapRef.current = null;
      trap.deactivate();
    };
  }, []);

  // Find current file index for navigation
  const currentIndex = files.findIndex((f) => f.id === file.id);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    // Wait for animation to complete
    setTimeout(() => {
      onClose();
    }, 150);
  }, [onClose]);

  const navigatePrev = useCallback(() => {
    if (currentIndex > 0) {
      onNavigate(files[currentIndex - 1]);
    }
  }, [currentIndex, files, onNavigate]);

  const navigateNext = useCallback(() => {
    if (currentIndex < files.length - 1) {
      onNavigate(files[currentIndex + 1]);
    }
  }, [currentIndex, files, onNavigate]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          handleClose();
          break;
        case ' ':
          // Space toggles the modal (close it)
          e.preventDefault();
          handleClose();
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault();
          navigatePrev();
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault();
          navigateNext();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, navigatePrev, navigateNext]);

  // Handle click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        handleClose();
      }
    },
    [handleClose]
  );

  const fileName = file.name ?? file.path.split(/[/\\]/).pop() ?? file.path;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1;
  const fileExt = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : undefined;
  const fileKind = fileExt ? `${fileExt} file` : file.is_dir ? 'Folder' : 'File';
  const fileSize = formatFileSize(file.size);
  const modified = formatLocalDateTime(file.modified);

  return (
    <div
      ref={backdropRef}
      className={`${styles.backdrop} ${isClosing ? styles.closing : ''}`}
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => focusTrapRef.current?.handleKeyDown(e)}
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.navigation}>
            <button
              className={styles.navButton}
              onClick={navigatePrev}
              disabled={!hasPrev}
              aria-label="Previous file"
              title="Previous file (Arrow Left)"
            >
              <Icon name="chevron-left" size={20} />
            </button>
            <span className={styles.fileCounter} aria-live="polite">
              {currentIndex + 1} / {files.length}
            </span>
            <button
              className={styles.navButton}
              onClick={navigateNext}
              disabled={!hasNext}
              aria-label="Next file"
              title="Next file (Arrow Right)"
            >
              <Icon name="chevron-right" size={20} />
            </button>
          </div>
          <div className={styles.titleBlock}>
            <h2 id={titleId} className={styles.title}>
              {fileName}
            </h2>
            <div className={styles.fileMetaLine}>
              <span>{fileKind}</span>
              <span>{fileSize}</span>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.infoButton}
              onClick={() => setShowInfo((value) => !value)}
              aria-label={showInfo ? 'Hide file info' : 'Show file info'}
              title={showInfo ? 'Hide file info' : 'Show file info'}
              aria-pressed={showInfo}
            >
              <Icon name="info" size={18} />
            </button>
            <button
              data-autofocus
              className={styles.closeButton}
              onClick={handleClose}
              aria-label="Close"
              title="Close (Escape)"
            >
              <Icon name="close" size={22} />
            </button>
          </div>
        </div>

        {/* Preview content */}
        <div className={styles.content}>
          <FilePreviewer key={file.id} file={file} variant="quicklook" />
        </div>

        {showInfo && (
          <aside className={styles.infoDrawer} aria-label="File info">
            <div>
              <span className={styles.infoLabel}>Name</span>
              <span className={styles.infoValue}>{fileName}</span>
            </div>
            <div>
              <span className={styles.infoLabel}>Kind</span>
              <span className={styles.infoValue}>{fileKind}</span>
            </div>
            <div>
              <span className={styles.infoLabel}>Size</span>
              <span className={styles.infoValue}>{fileSize}</span>
            </div>
            <div>
              <span className={styles.infoLabel}>Modified</span>
              <span className={styles.infoValue}>{modified}</span>
            </div>
            <div>
              <span className={styles.infoLabel}>Path</span>
              <span className={styles.infoValue}>{file.path}</span>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default QuickLookModal;
