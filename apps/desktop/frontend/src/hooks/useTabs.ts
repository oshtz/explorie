import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../store';
import { readStoredCurrentPath } from './useInitialPath';

export type TabItem = { id: string; path: string };

type UseTabsOptions = {
  currentPath: string;
  setCurrentPath: (path: string) => void;
  clearActiveSmartFolder: () => void;
  setSelectedFile: (file: FileEntry | null) => void;
};

export function useTabs({
  currentPath,
  setCurrentPath,
  clearActiveSmartFolder,
  setSelectedFile,
}: UseTabsOptions) {
  const initialTabs = (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:tabs');
        if (raw) {
          const arr = JSON.parse(raw);
          if (
            Array.isArray(arr) &&
            arr.every((t) => t && typeof t.id === 'string' && typeof t.path === 'string')
          ) {
            return arr as TabItem[];
          }
        }
      }
    } catch {}
    const init = readStoredCurrentPath() ?? '';
    return [{ id: `tab-${Date.now()}`, path: init }];
  })();

  const [tabs, setTabs] = useState<TabItem[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:activeTabId');
        if (v && typeof v === 'string') return v;
      }
    } catch {}
    return initialTabs[0]?.id ?? `tab-${Date.now()}`;
  });

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (!tabs.length) return;
    if (!tabs.find((t) => t.id === activeTabId)) {
      const fallback = tabs[0];
      setActiveTabId(fallback.id);
      if (fallback.path) setCurrentPath(fallback.path);
    }
  }, [tabs, activeTabId, setCurrentPath]);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:tabs', JSON.stringify(tabs));
    } catch {}
  }, [tabs]);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:activeTabId', activeTabId);
    } catch {}
  }, [activeTabId]);

  useEffect(() => {
    if (!currentPath) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, path: currentPath } : t)));
  }, [currentPath, activeTabId]);

  const addTab = useCallback(() => {
    const id = `tab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const basePath = currentPath || readStoredCurrentPath() || '';
    setTabs((prev) => [...prev, { id, path: basePath }]);
    setActiveTabId(id);
  }, [currentPath]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.filter((t) => t.id !== id);
        if (id === activeTabIdRef.current) {
          const pick = next[Math.max(0, idx - 1)] || next[0];
          setActiveTabId(pick.id);
          clearActiveSmartFolder();
          setCurrentPath(pick.path);
        }
        return next;
      });
    },
    [setCurrentPath, clearActiveSmartFolder]
  );

  const activateTab = useCallback(
    (id: string) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) return;
      setActiveTabId(id);
      setSelectedFile(null);
      clearActiveSmartFolder();
      setCurrentPath(t.path);
    },
    [tabs, setSelectedFile, clearActiveSmartFolder, setCurrentPath]
  );

  return {
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    addTab,
    closeTab,
    activateTab,
  };
}
