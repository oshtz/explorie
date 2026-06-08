import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useFileStore } from '../store';
import type { Workspace, WorkspaceTab } from '../store';
import { Icon } from './Icon';
import styles from './WorkspaceManager.module.css';

interface WorkspaceManagerProps {
  open: boolean;
  onClose: () => void;
  currentTabs: WorkspaceTab[];
  activeTabId: string;
  onLoadWorkspace: (workspace: Workspace) => void;
  // Optional window and sidebar state getters
  getWindowState?: () => Promise<{ width?: number; height?: number; x?: number; y?: number }>;
  getSidebarState?: () => { width?: number; collapsed?: boolean };
}

export function WorkspaceManager({
  open,
  onClose,
  currentTabs,
  activeTabId,
  onLoadWorkspace,
  getWindowState,
  getSidebarState,
}: WorkspaceManagerProps) {
  const workspaces = useFileStore((s) => s.workspaces);
  const saveWorkspace = useFileStore((s) => s.saveWorkspace);
  const deleteWorkspace = useFileStore((s) => s.deleteWorkspace);
  const renameWorkspace = useFileStore((s) => s.renameWorkspace);
  const loadWorkspace = useFileStore((s) => s.loadWorkspace);
  const lastWorkspaceId = useFileStore((s) => s.lastWorkspaceId);
  const exportWorkspace = useFileStore((s) => s.exportWorkspace);
  const importWorkspace = useFileStore((s) => s.importWorkspace);
  const exportAllWorkspaces = useFileStore((s) => s.exportAllWorkspaces);
  const importAllWorkspaces = useFileStore((s) => s.importAllWorkspaces);

  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get sorted workspace list
  const workspaceList = useMemo(() => {
    return Object.values(workspaces).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [workspaces]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setNewWorkspaceName('');
      setEditingId(null);
      setEditName('');
      setDeleteConfirmId(null);
      setImportMessage(null);
    }
  }, [open]);

  // Clear import message after a delay
  useEffect(() => {
    if (importMessage) {
      const timer = setTimeout(() => setImportMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [importMessage]);

  const handleSaveWorkspace = useCallback(async () => {
    const name = newWorkspaceName.trim();
    if (!name) return;
    const windowState = await getWindowState?.();
    const sidebarState = getSidebarState?.();
    saveWorkspace(name, currentTabs, activeTabId, windowState, sidebarState);
    setNewWorkspaceName('');
  }, [newWorkspaceName, currentTabs, activeTabId, saveWorkspace, getWindowState, getSidebarState]);

  const handleLoadWorkspace = useCallback(
    (workspace: Workspace) => {
      const loaded = loadWorkspace(workspace.id);
      if (loaded) {
        onLoadWorkspace(loaded);
        onClose();
      }
    },
    [loadWorkspace, onLoadWorkspace, onClose]
  );

  const handleStartEdit = useCallback((workspace: Workspace) => {
    setEditingId(workspace.id);
    setEditName(workspace.name);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (editingId && editName.trim()) {
      renameWorkspace(editingId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  }, [editingId, editName, renameWorkspace]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditName('');
  }, []);

  const handleDeleteClick = useCallback((id: string) => {
    setDeleteConfirmId(id);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (deleteConfirmId) {
      deleteWorkspace(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  }, [deleteConfirmId, deleteWorkspace]);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmId(null);
  }, []);

  // Export a single workspace
  const handleExportWorkspace = useCallback(
    (workspace: Workspace) => {
      const json = exportWorkspace(workspace.id);
      if (!json) return;
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${workspace.name.replace(/[^a-z0-9]/gi, '_')}_workspace.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [exportWorkspace]
  );

  // Export all workspaces
  const handleExportAll = useCallback(() => {
    const json = exportAllWorkspaces();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'explorie_workspaces.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [exportAllWorkspaces]);

  // Trigger file input for import
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Handle file selection for import
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        if (!text) {
          setImportMessage({ type: 'error', text: 'Failed to read file' });
          return;
        }

        try {
          // Try to parse and determine if it's a single workspace or array
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            // Import all workspaces
            const count = importAllWorkspaces(text);
            if (count > 0) {
              setImportMessage({
                type: 'success',
                text: `Imported ${count} workspace${count !== 1 ? 's' : ''}`,
              });
            } else {
              setImportMessage({ type: 'error', text: 'No valid workspaces found in file' });
            }
          } else {
            // Import single workspace
            const result = importWorkspace(text);
            if (result) {
              setImportMessage({ type: 'success', text: `Imported "${result.name}"` });
            } else {
              setImportMessage({ type: 'error', text: 'Invalid workspace file format' });
            }
          }
        } catch {
          setImportMessage({ type: 'error', text: 'Invalid JSON file' });
        }
      };
      reader.readAsText(file);

      // Reset input so the same file can be selected again
      e.target.value = '';
    },
    [importWorkspace, importAllWorkspaces]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingId) {
          handleCancelEdit();
        } else if (deleteConfirmId) {
          handleCancelDelete();
        } else {
          onClose();
        }
      }
    },
    [editingId, deleteConfirmId, handleCancelEdit, handleCancelDelete, onClose]
  );

  // Format date for display
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick} onKeyDown={handleKeyDown}>
      <div className={styles.dialog} role="dialog" aria-label="Workspace Manager">
        <div className={styles.header}>
          <h2 className={styles.title}>Workspaces</h2>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className={styles.body}>
          {/* Save new workspace section */}
          <div className={styles.saveSection}>
            <div className={styles.saveSectionTitle}>Save Current Workspace</div>
            <div className={styles.saveRow}>
              <input
                type="text"
                className={styles.input}
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="Workspace name..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveWorkspace();
                }}
              />
              <button
                className={styles.saveButton}
                onClick={handleSaveWorkspace}
                disabled={!newWorkspaceName.trim()}
              >
                <Icon name="save" />
                Save
              </button>
            </div>
            <div className={styles.saveInfo}>
              {currentTabs.length} tab{currentTabs.length !== 1 ? 's' : ''} will be saved
            </div>
          </div>

          {/* Workspace list */}
          <div className={styles.listSection}>
            <div className={styles.listTitle}>Saved Workspaces ({workspaceList.length})</div>
            {workspaceList.length === 0 ? (
              <div className={styles.emptyState}>
                No saved workspaces yet. Save your current tab layout above.
              </div>
            ) : (
              <div className={styles.list}>
                {workspaceList.map((workspace) => (
                  <div
                    key={workspace.id}
                    className={`${styles.workspaceItem} ${
                      lastWorkspaceId === workspace.id ? styles.workspaceActive : ''
                    }`}
                  >
                    {editingId === workspace.id ? (
                      <div className={styles.editRow}>
                        <input
                          type="text"
                          className={styles.editInput}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit();
                            if (e.key === 'Escape') handleCancelEdit();
                          }}
                          autoFocus
                        />
                        <button className={styles.iconButton} onClick={handleSaveEdit} title="Save">
                          <Icon name="check" />
                        </button>
                        <button
                          className={styles.iconButton}
                          onClick={handleCancelEdit}
                          title="Cancel"
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    ) : deleteConfirmId === workspace.id ? (
                      <div className={styles.deleteConfirm}>
                        <span>Delete "{workspace.name}"?</span>
                        <button
                          className={`${styles.iconButton} ${styles.deleteConfirmButton}`}
                          onClick={handleConfirmDelete}
                          title="Confirm delete"
                        >
                          <Icon name="trash" />
                        </button>
                        <button
                          className={styles.iconButton}
                          onClick={handleCancelDelete}
                          title="Cancel"
                        >
                          <Icon name="x" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div
                          className={styles.workspaceInfo}
                          onClick={() => handleLoadWorkspace(workspace)}
                        >
                          <div className={styles.workspaceName}>{workspace.name}</div>
                          <div className={styles.workspaceMeta}>
                            {workspace.tabs.length} tab{workspace.tabs.length !== 1 ? 's' : ''} •{' '}
                            {formatDate(workspace.updatedAt)}
                          </div>
                        </div>
                        <div className={styles.workspaceActions}>
                          <button
                            className={styles.iconButton}
                            onClick={() => handleExportWorkspace(workspace)}
                            title="Export"
                          >
                            <Icon name="download" />
                          </button>
                          <button
                            className={styles.iconButton}
                            onClick={() => handleStartEdit(workspace)}
                            title="Rename"
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            className={styles.iconButton}
                            onClick={() => handleDeleteClick(workspace.id)}
                            title="Delete"
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          {importMessage && (
            <div className={`${styles.importMessage} ${styles[importMessage.type]}`}>
              {importMessage.text}
            </div>
          )}

          <div className={styles.footerActions}>
            <button
              className={styles.footerButton}
              onClick={handleImportClick}
              title="Import workspaces from JSON file"
            >
              <Icon name="upload" />
              Import
            </button>
            <button
              className={styles.footerButton}
              onClick={handleExportAll}
              disabled={workspaceList.length === 0}
              title="Export all workspaces to JSON file"
            >
              <Icon name="download" />
              Export All
            </button>
          </div>

          <button className={styles.cancelButton} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default WorkspaceManager;
