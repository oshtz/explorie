import React, { useState, useCallback } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';
import { useOperationQueueStore } from '../operationQueueStore';
import type { ErrorReport } from '../utils/errorReporter';
import { getErrorReports, clearErrorReports, exportErrorReports } from '../utils/errorReporter';
import type { LogEntry } from '../utils/logger';
import { logger } from '../utils/logger';
import { copyDiagnosticsJson, downloadDiagnosticsJson } from '../utils/diagnosticsReport';
import styles from './DebugPanel.module.css';

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
}

type DebugTab = 'state' | 'operations' | 'errors' | 'logs' | 'diagnostics';

/**
 * Debug panel for viewing internal application state.
 * Useful for development and troubleshooting.
 */
export function DebugPanel({ open, onClose }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<DebugTab>('state');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['files', 'selection'])
  );
  const [errorReports, setErrorReports] = useState<ErrorReport[]>([]);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);

  // File store state
  const pathStack = useFileStore((s) => s.pathStack);
  const currentPath = pathStack.length > 0 ? pathStack[pathStack.length - 1] : '';
  const files = useFileStore((s) => s.files);
  const loading = useFileStore((s) => s.loading);
  const error = useFileStore((s) => s.error);
  const viewMode = useFileStore((s) => s.viewMode);
  const theme = useFileStore((s) => s.theme);
  const clipboard = useFileStore((s) => s.clipboard);
  const favorites = useFileStore((s) => s.favorites);
  const activeSmartFolderId = useFileStore((s) => s.activeSmartFolderId);

  // Undo/redo state
  const undoStack = useUndoRedoStore((s) => s.undoStack);
  const redoStack = useUndoRedoStore((s) => s.redoStack);

  // Operation queue state
  const operations = useOperationQueueStore((s) => s.operations);
  const hasActiveOps = useOperationQueueStore((s) => s.hasActiveOperations());

  // Refresh error reports when tab changes
  const refreshErrorReports = useCallback(() => {
    setErrorReports(getErrorReports());
  }, []);

  // Handle tab change
  const handleTabChange = useCallback(
    (tab: DebugTab) => {
      setActiveTab(tab);
      if (tab === 'errors') {
        refreshErrorReports();
      }
    },
    [refreshErrorReports]
  );

  // Toggle section expansion
  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  // Export state as JSON
  const exportState = useCallback(() => {
    const state = {
      exportedAt: new Date().toISOString(),
      fileStore: {
        currentPath,
        filesCount: files.length,
        loading,
        error,
        viewMode,
        theme,
        clipboard,
        pathStack,
        favoritesCount: favorites.length,
        activeSmartFolderId,
      },
      undoRedo: {
        undoStackSize: undoStack.length,
        redoStackSize: redoStack.length,
      },
      operations: {
        hasActiveOperations: hasActiveOps,
        operationsCount: operations.length,
        operations: operations.map((op) => ({
          id: op.id,
          type: op.type,
          status: op.status,
          progress: op.totalBytes > 0 ? op.processedBytes / op.totalBytes : 0,
          error: op.error,
        })),
      },
    };
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `explorie-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [
    currentPath,
    files,
    loading,
    error,
    viewMode,
    theme,
    clipboard,
    pathStack,
    favorites,
    activeSmartFolderId,
    undoStack,
    redoStack,
    hasActiveOps,
    operations,
  ]);

  // Clear error reports
  const handleClearErrors = useCallback(() => {
    clearErrorReports();
    refreshErrorReports();
  }, [refreshErrorReports]);

  // Export error reports
  const handleExportErrors = useCallback(() => {
    const json = exportErrorReports();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `explorie-errors-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleCopyDiagnostics = useCallback(async () => {
    try {
      await copyDiagnosticsJson();
      setDiagnosticsStatus('Diagnostics copied');
    } catch {
      setDiagnosticsStatus('Diagnostics copy failed');
    }
  }, []);

  const handleDownloadDiagnostics = useCallback(() => {
    downloadDiagnosticsJson();
    setDiagnosticsStatus('Diagnostics downloaded');
  }, []);

  // Get logs from logger
  const logs = logger.getBuffer();

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Debug Panel</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'state' ? styles.active : ''}`}
            onClick={() => handleTabChange('state')}
          >
            State
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'operations' ? styles.active : ''}`}
            onClick={() => handleTabChange('operations')}
          >
            Operations ({operations.length})
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'errors' ? styles.active : ''}`}
            onClick={() => handleTabChange('errors')}
          >
            Errors ({errorReports.length})
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'logs' ? styles.active : ''}`}
            onClick={() => handleTabChange('logs')}
          >
            Logs
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'diagnostics' ? styles.active : ''}`}
            onClick={() => handleTabChange('diagnostics')}
          >
            Diagnostics
          </button>
        </div>

        <div className={styles.content}>
          {activeTab === 'state' && (
            <div className={styles.stateTab}>
              {/* Files section */}
              <div className={styles.section}>
                <button className={styles.sectionHeader} onClick={() => toggleSection('files')}>
                  <span>{expandedSections.has('files') ? '▼' : '▶'}</span>
                  <span>Files ({files.length})</span>
                </button>
                {expandedSections.has('files') && (
                  <div className={styles.sectionContent}>
                    <div className={styles.item}>
                      <span className={styles.label}>Current Path:</span>
                      <span className={styles.value}>{currentPath || '(none)'}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.label}>Files Count:</span>
                      <span className={styles.value}>{files.length}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.label}>Loading:</span>
                      <span className={styles.value}>{loading ? 'Yes' : 'No'}</span>
                    </div>
                    {error && (
                      <div className={styles.item}>
                        <span className={styles.label}>Error:</span>
                        <span className={styles.value + ' ' + styles.error}>{error}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* View section */}
              <div className={styles.section}>
                <button className={styles.sectionHeader} onClick={() => toggleSection('view')}>
                  <span>{expandedSections.has('view') ? '▼' : '▶'}</span>
                  <span>View</span>
                </button>
                {expandedSections.has('view') && (
                  <div className={styles.sectionContent}>
                    <div className={styles.item}>
                      <span className={styles.label}>View Mode:</span>
                      <span className={styles.value}>{viewMode}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.label}>Theme:</span>
                      <span className={styles.value}>{theme}</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.label}>Path Stack:</span>
                      <span className={styles.value}>{pathStack.length} levels</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Clipboard section */}
              <div className={styles.section}>
                <button className={styles.sectionHeader} onClick={() => toggleSection('clipboard')}>
                  <span>{expandedSections.has('clipboard') ? '▼' : '▶'}</span>
                  <span>
                    Clipboard {clipboard ? `(${clipboard.items.length} items)` : '(empty)'}
                  </span>
                </button>
                {expandedSections.has('clipboard') && (
                  <div className={styles.sectionContent}>
                    {clipboard ? (
                      <>
                        <div className={styles.item}>
                          <span className={styles.label}>Mode:</span>
                          <span className={styles.value}>{clipboard.mode}</span>
                        </div>
                        <div className={styles.item}>
                          <span className={styles.label}>Source Path:</span>
                          <span className={styles.value}>{clipboard.sourcePath}</span>
                        </div>
                        <div className={styles.item}>
                          <span className={styles.label}>Items:</span>
                          <ul className={styles.list}>
                            {clipboard.items.slice(0, 5).map((item: FileEntry) => (
                              <li key={item.id}>{item.name}</li>
                            ))}
                            {clipboard.items.length > 5 && (
                              <li>... and {clipboard.items.length - 5} more</li>
                            )}
                          </ul>
                        </div>
                      </>
                    ) : (
                      <div className={styles.empty}>Clipboard is empty</div>
                    )}
                  </div>
                )}
              </div>

              {/* Undo/Redo section */}
              <div className={styles.section}>
                <button className={styles.sectionHeader} onClick={() => toggleSection('undoRedo')}>
                  <span>{expandedSections.has('undoRedo') ? '▼' : '▶'}</span>
                  <span>Undo/Redo</span>
                </button>
                {expandedSections.has('undoRedo') && (
                  <div className={styles.sectionContent}>
                    <div className={styles.item}>
                      <span className={styles.label}>Undo Stack:</span>
                      <span className={styles.value}>{undoStack.length} operations</span>
                    </div>
                    <div className={styles.item}>
                      <span className={styles.label}>Redo Stack:</span>
                      <span className={styles.value}>{redoStack.length} operations</span>
                    </div>
                  </div>
                )}
              </div>

              <button className={styles.exportButton} onClick={exportState}>
                Export State
              </button>
            </div>
          )}

          {activeTab === 'operations' && (
            <div className={styles.operationsTab}>
              {operations.length === 0 ? (
                <div className={styles.empty}>No active operations</div>
              ) : (
                <div className={styles.operationsList}>
                  {operations.map((op) => (
                    <div
                      key={op.id}
                      className={`${styles.operation} ${op.status === 'running' ? styles.active : ''}`}
                    >
                      <div className={styles.operationHeader}>
                        <span className={styles.operationType}>{op.type}</span>
                        <span className={`${styles.operationStatus} ${styles[op.status]}`}>
                          {op.status}
                        </span>
                      </div>
                      <div className={styles.operationDetails}>
                        <span>
                          Progress:{' '}
                          {Math.round(
                            (op.totalBytes > 0 ? op.processedBytes / op.totalBytes : 0) * 100
                          )}
                          %
                        </span>
                        {op.error && <span className={styles.error}>{op.error}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'errors' && (
            <div className={styles.errorsTab}>
              <div className={styles.errorActions}>
                <button onClick={refreshErrorReports}>Refresh</button>
                <button onClick={handleClearErrors}>Clear All</button>
                <button onClick={handleExportErrors}>Export</button>
              </div>
              {errorReports.length === 0 ? (
                <div className={styles.empty}>No error reports collected</div>
              ) : (
                <div className={styles.errorsList}>
                  {errorReports.map((report) => (
                    <div key={report.id} className={styles.errorReport}>
                      <div className={styles.errorHeader}>
                        <span className={styles.errorOperation}>{report.operation}</span>
                        <span className={styles.errorTime}>
                          {new Date(report.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className={styles.errorMessage}>{report.error.message}</div>
                      <div className={styles.errorCategory}>Category: {report.error.category}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'logs' && (
            <div className={styles.logsTab}>
              {logs.length === 0 ? (
                <div className={styles.empty}>No logs captured</div>
              ) : (
                <div className={styles.logsList}>
                  {logs
                    .slice(-100)
                    .reverse()
                    .map((log: LogEntry) => (
                      <div
                        key={`${log.timestamp}-${log.levelName}-${log.message}`}
                        className={`${styles.logEntry} ${styles[log.levelName.toLowerCase()]}`}
                      >
                        <span className={styles.logTime}>
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span className={styles.logLevel}>[{log.levelName}]</span>
                        <span className={styles.logMessage}>{log.message}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'diagnostics' && (
            <div className={styles.diagnosticsTab}>
              <div className={styles.diagnosticsActions}>
                <button onClick={handleCopyDiagnostics}>Copy diagnostics JSON</button>
                <button onClick={handleDownloadDiagnostics}>Download diagnostics JSON</button>
              </div>
              {diagnosticsStatus && (
                <div className={styles.diagnosticsStatus}>{diagnosticsStatus}</div>
              )}
              <div className={styles.diagnosticsNote}>
                Diagnostics export is local-only and redacts path-like values.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
