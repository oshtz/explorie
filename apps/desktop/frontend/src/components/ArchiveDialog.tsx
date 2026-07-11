import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FileEntry } from '../store';
import { Icon } from './Icon';
import { formatErrorMessage } from '../utils/errorMessages';
import { createFocusTrap } from '../utils/accessibility';
import styles from './ArchiveDialog.module.css';

type ArchiveMode = 'compress' | 'extract';
type ArchiveFormat = 'zip' | 'tar.gz' | 'tar' | '7z';
type CompressionLevel = 'none' | 'fast' | 'normal' | 'best';

interface ArchiveEntry {
  name: string;
  path: string;
  size: number;
  compressed_size: number;
  is_dir: boolean;
}

interface ArchiveInfo {
  format: string;
  total_size: number;
  compressed_size: number;
  entry_count: number;
  entries: ArchiveEntry[];
}

interface CompressResult {
  output_path: string;
  total_bytes: number;
}

interface CompressProgressPayload {
  operationId: string;
  processedBytes: number;
  totalBytes: number;
  currentPath: string;
}

interface ExtractResult {
  output_dir: string;
  total_bytes: number;
}

interface ArchiveDialogProps {
  open: boolean;
  mode: ArchiveMode;
  files: FileEntry[];
  currentPath: string;
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
}

// Helper to format file size
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// Helper to get archive name from files
function getDefaultArchiveName(files: FileEntry[]): string {
  if (files.length === 1) {
    const name = files[0].name || files[0].path.split(/[/\\]/).pop() || 'archive';
    // Remove extension if it's a file
    if (!files[0].is_dir) {
      const lastDot = name.lastIndexOf('.');
      return lastDot > 0 ? name.slice(0, lastDot) : name;
    }
    return name;
  }
  return 'Archive';
}

// Helper to check if file is an archive
function isArchiveFile(file: FileEntry): boolean {
  const name = (file.name || file.path).toLowerCase();
  return (
    name.endsWith('.zip') ||
    name.endsWith('.tar.gz') ||
    name.endsWith('.tgz') ||
    name.endsWith('.tar') ||
    name.endsWith('.7z') ||
    name.endsWith('.rar')
  );
}

export function ArchiveDialog({
  open,
  mode,
  files,
  currentPath,
  onClose,
  onSuccess,
}: ArchiveDialogProps) {
  // State
  const [format, setFormat] = useState<ArchiveFormat>('zip');
  const [compressionLevel, setCompressionLevel] = useState<CompressionLevel>('normal');
  const [archiveName, setArchiveName] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [archiveInfo, setArchiveInfo] = useState<ArchiveInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [entrySearch, setEntrySearch] = useState('');
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

  // Load archive info for extraction preview
  const loadArchiveInfo = useCallback(async (path: string) => {
    setLoadingInfo(true);
    setError(null);
    try {
      const info = await invoke<ArchiveInfo>('list_archive', { archivePath: path });
      setArchiveInfo(info);
    } catch (e) {
      setError(`Failed to read archive: ${formatErrorMessage(e)}`);
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setFormat('zip');
      setCompressionLevel('normal');
      setArchiveName(getDefaultArchiveName(files));
      setOutputDir(currentPath);
      setProcessing(false);
      setProgress(0);
      setError(null);
      setSuccess(null);
      setArchiveInfo(null);
      setEntrySearch('');

      // If extracting, load archive info
      if (mode === 'extract' && files.length === 1 && isArchiveFile(files[0])) {
        loadArchiveInfo(files[0].path);
      }
    }
  }, [open, mode, files, currentPath, loadArchiveInfo]);

  // Get output path for compression
  const outputPath = useMemo(() => {
    if (mode !== 'compress') return '';
    const ext = format === 'tar.gz' ? 'tar.gz' : format;
    const safeName = archiveName.replace(/[/\\:*?"<>|]/g, '_') || 'archive';
    return `${outputDir.replace(/[/\\]$/, '')}/${safeName}.${ext}`;
  }, [mode, format, archiveName, outputDir]);

  const filteredEntries = useMemo(() => {
    if (!archiveInfo) return [];
    const query = entrySearch.trim().toLowerCase();
    if (!query) return archiveInfo.entries;
    return archiveInfo.entries.filter((entry) => entry.path.toLowerCase().includes(query));
  }, [archiveInfo, entrySearch]);

  // Handle compress
  const handleCompress = useCallback(async () => {
    if (processing || files.length === 0) return;

    const operationId = `compress-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let unlisten: (() => void) | null = null;

    setProcessing(true);
    setProgress(0);
    setError(null);
    setSuccess(null);

    try {
      unlisten = await listen<CompressProgressPayload>('archive:compress-progress', (event) => {
        if (event.payload.operationId !== operationId) return;
        const { processedBytes, totalBytes } = event.payload;
        if (totalBytes <= 0) return;
        const percent = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
        setProgress(percent);
      });

      const paths = files.map((f) => f.path);
      const result = await invoke<CompressResult>('compress_files', {
        paths,
        outputPath,
        format,
        compressionLevel,
        operationId,
      });

      setProgress(100);
      setSuccess(`Created ${result.output_path} (${formatSize(result.total_bytes)} compressed)`);

      // Call success callback after a brief delay to show success message
      setTimeout(async () => {
        await onSuccess?.();
      }, 500);
    } catch (e) {
      setError(`Compression failed: ${formatErrorMessage(e)}`);
    } finally {
      if (unlisten) {
        unlisten();
      }
      setProcessing(false);
    }
  }, [processing, files, outputPath, format, compressionLevel, onSuccess]);

  // Handle extract
  const handleExtract = useCallback(async () => {
    if (processing || files.length !== 1) return;

    setProcessing(true);
    setProgress(0);
    setError(null);
    setSuccess(null);

    try {
      const result = await invoke<ExtractResult>('extract_archive_cmd', {
        archivePath: files[0].path,
        outputDir,
      });

      setProgress(100);
      setSuccess(`Extracted ${formatSize(result.total_bytes)} to ${result.output_dir}`);

      // Call success callback after a brief delay
      setTimeout(async () => {
        await onSuccess?.();
      }, 500);
    } catch (e) {
      setError(`Extraction failed: ${formatErrorMessage(e)}`);
    } finally {
      setProcessing(false);
    }
  }, [processing, files, outputDir, onSuccess]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !processing) {
        onClose();
      }
    },
    [onClose, processing]
  );

  if (!open) return null;

  const isCompress = mode === 'compress';
  const canProcess = isCompress
    ? files.length > 0 && archiveName.trim() && !processing
    : files.length === 1 && outputDir.trim() && !processing;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-dialog-title"
        onKeyDown={(e) => {
          focusTrapRef.current?.handleKeyDown(e);
          if (e.key === 'Escape' && !processing) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <Icon name={isCompress ? 'archive' : 'unarchive'} />
          </div>
          <div>
            <h2 id="archive-dialog-title" className={styles.title}>
              {isCompress ? 'Create Archive' : 'Extract Archive'}
            </h2>
            <span className={styles.subtitle}>
              {isCompress
                ? `${files.length} item${files.length !== 1 ? 's' : ''} selected`
                : files[0]?.name || 'Archive'}
            </span>
          </div>
          <button
            className={styles.closeButton}
            onClick={onClose}
            disabled={processing}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className={styles.body}>
          {/* File list (compress mode) */}
          {isCompress && files.length > 0 && (
            <div className={styles.fileList}>
              {files.slice(0, 5).map((file) => (
                <div key={file.id} className={styles.fileItem}>
                  <span className={styles.fileIcon}>
                    <Icon name={file.is_dir ? 'folder' : 'file'} />
                  </span>
                  <span className={styles.fileName}>
                    {file.name || file.path.split(/[/\\]/).pop()}
                  </span>
                  <span className={styles.fileSize}>{formatSize(file.size || 0)}</span>
                </div>
              ))}
              {files.length > 5 && (
                <div className={styles.moreFiles}>... and {files.length - 5} more items</div>
              )}
            </div>
          )}

          {/* Archive preview (extract mode) */}
          {!isCompress && archiveInfo && (
            <div className={styles.archivePreview}>
              <div className={styles.archiveStats}>
                <div className={styles.archiveStat}>
                  <span className={styles.archiveStatLabel}>Files</span>
                  <span className={styles.archiveStatValue}>{archiveInfo.entry_count}</span>
                </div>
                <div className={styles.archiveStat}>
                  <span className={styles.archiveStatLabel}>Uncompressed</span>
                  <span className={styles.archiveStatValue}>
                    {formatSize(archiveInfo.total_size)}
                  </span>
                </div>
                <div className={styles.archiveStat}>
                  <span className={styles.archiveStatLabel}>Compressed</span>
                  <span className={styles.archiveStatValue}>
                    {formatSize(archiveInfo.compressed_size)}
                  </span>
                </div>
              </div>
              {archiveInfo.entries.length > 0 && (
                <>
                  <div className={styles.archiveSearch}>
                    <input
                      aria-label="Search archive contents"
                      type="text"
                      className={`${styles.input} ${styles.archiveSearchInput}`}
                      value={entrySearch}
                      onChange={(e) => setEntrySearch(e.target.value)}
                      placeholder="Search archive contents..."
                      disabled={loadingInfo}
                    />
                    <span className={styles.archiveSearchMeta}>
                      {filteredEntries.length} of {archiveInfo.entry_count} entries
                    </span>
                  </div>
                  {filteredEntries.length > 0 ? (
                    <div className={styles.archiveContents}>
                      {filteredEntries.slice(0, 10).map((entry) => (
                        <div key={entry.path} className={styles.archiveEntry}>
                          <span className={styles.archiveEntryIcon}>
                            <Icon name={entry.is_dir ? 'folder' : 'file'} />
                          </span>
                          <span className={styles.archiveEntryName}>{entry.path}</span>
                          <span className={styles.archiveEntrySize}>{formatSize(entry.size)}</span>
                        </div>
                      ))}
                      {filteredEntries.length > 10 && (
                        <div className={styles.moreFiles}>
                          ... and {filteredEntries.length - 10} more entries
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className={styles.archiveEmpty}>No matching entries found.</div>
                  )}
                </>
              )}
            </div>
          )}

          {loadingInfo && (
            <div className={styles.progressSection}>
              <span className={styles.progressLabel}>Loading archive contents...</span>
            </div>
          )}

          {/* Options */}
          <div className={styles.options}>
            {isCompress && (
              <>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="archive-name">
                    Archive Name
                  </label>
                  <input
                    id="archive-name"
                    data-autofocus
                    type="text"
                    className={styles.input}
                    value={archiveName}
                    onChange={(e) => setArchiveName(e.target.value)}
                    placeholder="Enter archive name..."
                    disabled={processing}
                  />
                </div>

                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="archive-format">
                      Format
                    </label>
                    <select
                      id="archive-format"
                      className={styles.select}
                      value={format}
                      onChange={(e) => setFormat(e.target.value as ArchiveFormat)}
                      disabled={processing}
                    >
                      <option value="zip">ZIP (.zip)</option>
                      <option value="7z">7Z (.7z)</option>
                      <option value="tar.gz">TAR.GZ (.tar.gz)</option>
                      <option value="tar">TAR (.tar)</option>
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="archive-compression">
                      Compression
                    </label>
                    <select
                      id="archive-compression"
                      className={styles.select}
                      value={compressionLevel}
                      onChange={(e) => setCompressionLevel(e.target.value as CompressionLevel)}
                      disabled={processing || format === 'tar' || format === '7z'}
                    >
                      <option value="none">None (fastest)</option>
                      <option value="fast">Fast</option>
                      <option value="normal">Normal</option>
                      <option value="best">Best (slowest)</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            <div className={styles.field}>
              <label className={styles.label} htmlFor="archive-output-dir">
                {isCompress ? 'Save To' : 'Extract To'}
              </label>
              <div className={styles.pathField}>
                <input
                  id="archive-output-dir"
                  data-autofocus={!isCompress || undefined}
                  type="text"
                  className={`${styles.input} ${styles.pathInput}`}
                  value={outputDir}
                  onChange={(e) => setOutputDir(e.target.value)}
                  placeholder="Output directory..."
                  disabled={processing}
                />
              </div>
              {isCompress && <span className={styles.hint}>Output: {outputPath}</span>}
            </div>
          </div>

          {/* Progress */}
          {processing && (
            <div className={styles.progressSection}>
              <div className={styles.progressLabel}>
                <span>{isCompress ? 'Compressing...' : 'Extracting...'}</span>
                <span>{progress}%</span>
              </div>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className={styles.error}>
              <span className={styles.errorIcon}>
                <Icon name="warning-box" />
              </span>
              {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div className={styles.success}>
              <span className={styles.successIcon}>
                <Icon name="check" />
              </span>
              {success}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelButton} onClick={onClose} disabled={processing}>
            {success ? 'Close' : 'Cancel'}
          </button>
          {!success && (
            <button
              className={styles.primaryButton}
              onClick={isCompress ? handleCompress : handleExtract}
              disabled={!canProcess}
            >
              <Icon name={isCompress ? 'archive' : 'unarchive'} />
              {processing
                ? isCompress
                  ? 'Compressing...'
                  : 'Extracting...'
                : isCompress
                  ? 'Create Archive'
                  : 'Extract'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ArchiveDialog;
