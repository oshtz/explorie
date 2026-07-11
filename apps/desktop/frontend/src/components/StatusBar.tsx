import React, { useMemo, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { useShallow } from 'zustand/shallow';
import type { FileOperation } from '../operationQueueStore';
import { useOperationQueueStore } from '../operationQueueStore';
import styles from './StatusBar.module.css';
import { basename } from '../utils/path';

interface DiskInfo {
  mount_point: string;
  total_space: number;
  available_space: number;
  name: string;
}

interface StatusBarProps {
  files: FileEntry[];
  selectedFile: FileEntry | null;
  currentPath: string;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getOperationProgress(operation: FileOperation): number | null {
  if (operation.totalBytes > 0) {
    return Math.round((operation.processedBytes / operation.totalBytes) * 100);
  }
  if (operation.totalItems > 0) {
    return Math.round((operation.processedItems / operation.totalItems) * 100);
  }
  return null;
}

export function StatusBar({ files, selectedFile, currentPath }: StatusBarProps) {
  const { viewMode, filterMode, searchQuery, showHidden } = useFileStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      filterMode: s.filterMode,
      searchQuery: s.searchQuery,
      showHidden: s.showHidden,
    }))
  );
  const { operations, setShowProgressPanel } = useOperationQueueStore(
    useShallow((s) => ({
      operations: s.operations,
      setShowProgressPanel: s.setShowProgressPanel,
    }))
  );

  // Disk space state
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);

  // Fetch disk info when currentPath changes
  useEffect(() => {
    if (!currentPath) return;

    let cancelled = false;
    invoke<DiskInfo>('get_disk_info', { path: currentPath })
      .then((info) => {
        if (!cancelled) {
          setDiskInfo(info);
        }
      })
      .catch((err) => {
        console.warn('Failed to get disk info:', err);
        if (!cancelled) {
          setDiskInfo(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Compute file statistics
  const stats = useMemo(() => {
    const folderCount = files.filter((f) => f.is_dir).length;
    const fileCount = files.filter((f) => !f.is_dir).length;
    const totalSize = files.reduce((acc, f) => acc + (f.is_dir ? 0 : f.size), 0);
    const hiddenCount = files.filter((f) => f.hidden).length;
    return { folderCount, fileCount, totalSize, hiddenCount };
  }, [files]);

  // Build item count string
  const itemCountStr = useMemo(() => {
    const parts: string[] = [];
    if (stats.folderCount > 0) {
      parts.push(`${stats.folderCount} folder${stats.folderCount !== 1 ? 's' : ''}`);
    }
    if (stats.fileCount > 0) {
      parts.push(`${stats.fileCount} file${stats.fileCount !== 1 ? 's' : ''}`);
    }
    if (parts.length === 0) return 'Empty folder';
    return parts.join(', ');
  }, [stats]);

  // Build filter/search status
  const filterStatus = useMemo(() => {
    const parts: string[] = [];
    if (filterMode !== 'all') {
      parts.push(`Showing ${filterMode}`);
    }
    if (searchQuery) {
      parts.push(`Searching "${searchQuery}"`);
    }
    if (!showHidden && stats.hiddenCount > 0) {
      parts.push(`${stats.hiddenCount} hidden`);
    }
    return parts.join(' / ');
  }, [filterMode, searchQuery, showHidden, stats.hiddenCount]);

  // Selected file info
  const selectionInfo = useMemo(() => {
    if (!selectedFile) return null;
    const name = selectedFile.name ?? basename(selectedFile.path) ?? '';
    if (selectedFile.is_dir) {
      return `Selected: ${name}`;
    }
    return `Selected: ${name} (${formatFileSize(selectedFile.size)})`;
  }, [selectedFile]);

  // Disk space info string
  const diskSpaceInfo = useMemo(() => {
    if (!diskInfo) return null;
    const free = formatFileSize(diskInfo.available_space);
    const total = formatFileSize(diskInfo.total_space);
    return `${free} free of ${total}`;
  }, [diskInfo]);

  const operationSummary = useMemo(() => {
    const active = operations.filter((o) => o.status === 'running');
    if (active.length === 0) return null;
    const primary = active.find((o) => o.status === 'running') ?? active[0];
    const typeLabel: Record<FileOperation['type'], string> = {
      copy: 'Copying',
      move: 'Moving',
      delete: 'Deleting',
    };
    if (active.length === 1) {
      const progress = getOperationProgress(primary);
      const label =
        progress !== null ? `${typeLabel[primary.type]} ${progress}%` : typeLabel[primary.type];
      const detail =
        primary.totalItems > 0
          ? `${primary.processedItems}/${primary.totalItems} items`
          : primary.currentItem || primary.destinationPath || '';
      const title = detail ? `${label} (${detail})` : label;
      return { label, title };
    }
    const label = `${active.length} operations`;
    const title = active.map((op) => op.type).join(', ');
    return { label, title };
  }, [operations]);

  return (
    <div className={styles.statusBar}>
      <div className={styles.leftCluster}>
        <div className={styles.section}>
          <span className={styles.itemCount}>{itemCountStr}</span>
          {stats.totalSize > 0 && (
            <span className={styles.totalSize}>{formatFileSize(stats.totalSize)}</span>
          )}
        </div>

        {filterStatus && (
          <div className={styles.section}>
            <span className={styles.filterStatus}>{filterStatus}</span>
          </div>
        )}

        {operationSummary && (
          <button
            type="button"
            className={`${styles.section} ${styles.clickable}`}
            onClick={() => setShowProgressPanel(true)}
            title={operationSummary.title}
            aria-label={`${operationSummary.title}. Show operation details`}
            aria-live="polite"
          >
            <span className={styles.operationStatus}>{operationSummary.label}</span>
          </button>
        )}
      </div>

      <div className={styles.rightCluster}>
        {selectionInfo && (
          <div className={`${styles.section} ${styles.selectionSection}`}>
            <span className={styles.selection}>{selectionInfo}</span>
          </div>
        )}

        {diskSpaceInfo && (
          <div
            className={`${styles.section} ${styles.diskSection}`}
            title={`Disk: ${diskInfo?.name || 'Unknown'}`}
          >
            <span className={styles.diskSpace}>{diskSpaceInfo}</span>
          </div>
        )}

        <div className={`${styles.section} ${styles.viewSection}`}>
          <span className={styles.viewMode}>
            {viewMode === 'list' ? 'List' : viewMode === 'grid' ? 'Grid' : 'Column'} view
          </span>
        </div>
      </div>
    </div>
  );
}

export default StatusBar;
