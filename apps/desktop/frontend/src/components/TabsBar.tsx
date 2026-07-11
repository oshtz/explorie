import React from 'react';
import styles from './TabsBar.module.css';
import { Icon } from './Icon';
import { basename, isDriveRoot, normalizePath } from '../utils/path';

export interface TabItem {
  id: string;
  path: string;
}

interface TabsBarProps {
  tabs: TabItem[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onReorder?: (fromId: string, toId: string) => void;
  fileDragActive?: boolean;
  onFileDragHover?: (path: string | null) => void;
}

export function TabsBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onAdd,
  onReorder,
  fileDragActive = false,
  onFileDragHover,
}: TabsBarProps) {
  const idPrefix = React.useId();
  const [draggedTabId, setDraggedTabId] = React.useState<string | null>(null);
  const draggedTabRef = React.useRef<string | null>(null);
  const [fileDropTabId, setFileDropTabId] = React.useState<string | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  React.useEffect(() => () => clearHoverTimer(), []);
  const titleFor = (p: string) => {
    if (!p) return 'Untitled';
    const normalized = normalizePath(p);
    // Windows drive root like C:/
    if (isDriveRoot(normalized)) return normalized.toUpperCase();
    const name = basename(normalized);
    return name || normalized || 'Untitled';
  };

  const activateFromKey = (event: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? tabs.length - 1 : index - 1;
    else if (event.key === 'ArrowRight') nextIndex = index === tabs.length - 1 ? 0 : index + 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return false;

    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return true;
    onActivate(next.id);
    document.getElementById(`${idPrefix}-${next.id}`)?.focus();
    return true;
  };

  return (
    <div className={styles.tabsBar} role="tablist" aria-label="File tabs">
      {tabs.map((t, index) => (
        <div
          key={t.id}
          className={`${styles.tabItem} ${t.id === activeTabId ? styles.tabItemActive : ''} ${draggedTabId === t.id ? styles.tabDragging : ''} ${fileDropTabId === t.id ? styles.tabDropTarget : ''}`}
          role="presentation"
          draggable={!fileDragActive && !!onReorder}
          onDragStart={(event) => {
            draggedTabRef.current = t.id;
            setDraggedTabId(t.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-explorie-tab', t.id);
          }}
          onDragOver={(event) => {
            if (!draggedTabId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(event) => {
            const source =
              draggedTabRef.current || event.dataTransfer.getData('application/x-explorie-tab');
            if (!source) return;
            event.preventDefault();
            onReorder?.(source, t.id);
            draggedTabRef.current = null;
            setDraggedTabId(null);
          }}
          onDragEnd={() => {
            draggedTabRef.current = null;
            setDraggedTabId(null);
          }}
          onMouseEnter={() => {
            if (!fileDragActive) return;
            clearHoverTimer();
            setFileDropTabId(t.id);
            onFileDragHover?.(t.path);
            hoverTimerRef.current = setTimeout(() => onActivate(t.id), 700);
          }}
          onMouseLeave={() => {
            if (!fileDragActive) return;
            clearHoverTimer();
            setFileDropTabId(null);
            onFileDragHover?.(null);
          }}
        >
          <button
            id={`${idPrefix}-${t.id}`}
            className={styles.tabButton}
            role="tab"
            aria-selected={t.id === activeTabId}
            tabIndex={t.id === activeTabId ? 0 : -1}
            onClick={() => onActivate(t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                onClose(t.id);
              }
            }}
            onKeyDown={(e) => {
              if (activateFromKey(e, index)) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate(t.id);
              } else if ((e.key === 'Delete' || e.key === 'Backspace') && tabs.length > 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            title={t.path}
            type="button"
          >
            <Icon name="folder" />
            <span className={styles.tabTitle}>{titleFor(t.path)}</span>
          </button>
          {tabs.length > 1 && (
            <button
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Close tab"
              aria-label={`Close ${titleFor(t.path)} tab`}
              type="button"
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
      <button
        className={styles.addBtn}
        onClick={onAdd}
        title="New tab (Ctrl/Cmd+T)"
        aria-label="New tab"
        type="button"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

export default TabsBar;
