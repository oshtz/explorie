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
}

export function TabsBar({ tabs, activeTabId, onActivate, onClose, onAdd }: TabsBarProps) {
  const titleFor = (p: string) => {
    if (!p) return '•';
    const normalized = normalizePath(p);
    // Windows drive root like C:/
    if (isDriveRoot(normalized)) return normalized.toUpperCase();
    const name = basename(normalized);
    return name || normalized || '•';
  };

  return (
    <div className={styles.tabsBar} role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`${styles.tabItem} ${t.id === activeTabId ? styles.tabItemActive : ''}`}
          role="tab"
          aria-selected={t.id === activeTabId}
          tabIndex={t.id === activeTabId ? 0 : -1}
          onClick={() => onActivate(t.id)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              // middle-click closes
              e.preventDefault();
              e.stopPropagation();
              onClose(t.id);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onActivate(t.id);
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && tabs.length > 1) {
              e.preventDefault();
              onClose(t.id);
            }
          }}
          title={t.path}
        >
          <Icon name="folder" />
          <span className={styles.tabTitle}>{titleFor(t.path)}</span>
          {tabs.length > 1 && (
            <button
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Close tab"
              type="button"
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
      <button className={styles.addBtn} onClick={onAdd} title="New tab (Ctrl/Cmd+T)" type="button">
        <Icon name="plus" />
      </button>
    </div>
  );
}

export default TabsBar;
