import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FileEntry, Workspace } from '../store';
import type { TabItem } from './useTabs';

type UseWorkspaceManagerOptions = {
  currentPath: string;
  setTabs: (tabs: TabItem[]) => void;
  setActiveTabId: (id: string) => void;
  setCurrentPath: (path: string) => void;
  setSelectedFile: (file: FileEntry | null) => void;
  setSidebarWidth: (width: number) => void;
  sidebarWidth: number;
  clearActiveSmartFolder: () => void;
};

export function useWorkspaceManager({
  currentPath,
  setTabs,
  setActiveTabId,
  setCurrentPath,
  setSelectedFile,
  setSidebarWidth,
  sidebarWidth,
  clearActiveSmartFolder,
}: UseWorkspaceManagerOptions) {
  const handleLoadWorkspace = useCallback(
    async (workspace: Workspace) => {
      const newTabs: TabItem[] = workspace.tabs.map((t) => ({
        id: t.id,
        path: t.path,
      }));
      if (newTabs.length === 0) {
        newTabs.push({ id: `tab-${Date.now()}`, path: currentPath });
      }
      setTabs(newTabs);

      const activeExists = newTabs.some((t) => t.id === workspace.activeTabId);
      const newActiveId = activeExists ? workspace.activeTabId : newTabs[0].id;
      setActiveTabId(newActiveId);

      const activeTab = newTabs.find((t) => t.id === newActiveId);
      if (activeTab) {
        clearActiveSmartFolder();
        setCurrentPath(activeTab.path);
      }

      setSelectedFile(null);

      if (workspace.sidebarWidth !== undefined) {
        setSidebarWidth(workspace.sidebarWidth);
      }

      try {
        const appWindow = getCurrentWindow();
        if (workspace.windowWidth && workspace.windowHeight) {
          await appWindow.setSize(
            new (await import('@tauri-apps/api/dpi')).LogicalSize(
              workspace.windowWidth,
              workspace.windowHeight
            )
          );
        }
        if (workspace.windowX !== undefined && workspace.windowY !== undefined) {
          await appWindow.setPosition(
            new (await import('@tauri-apps/api/dpi')).LogicalPosition(
              workspace.windowX,
              workspace.windowY
            )
          );
        }
      } catch (e) {
        console.warn('Could not restore window position:', e);
      }
    },
    [
      currentPath,
      setTabs,
      setActiveTabId,
      setCurrentPath,
      setSelectedFile,
      setSidebarWidth,
      clearActiveSmartFolder,
    ]
  );

  const getWindowState = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const size = await appWindow.outerSize();
      const position = await appWindow.outerPosition();
      return {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
      };
    } catch {
      return {};
    }
  }, []);

  const getSidebarState = useCallback(() => {
    return {
      width: sidebarWidth,
      collapsed: false,
    };
  }, [sidebarWidth]);

  return {
    handleLoadWorkspace,
    getWindowState,
    getSidebarState,
  };
}
