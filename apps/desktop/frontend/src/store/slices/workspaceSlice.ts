import type { StateCreator } from 'zustand';
import type {
  StoreState,
  WorkspaceSlice,
  Workspace,
  WorkspaceTab,
  SmartFolder,
  SmartFolderCriteria,
} from '../types';
import type { SortKey, SortDir } from '../../components/FileTable';

type WorkspaceImportRecord = Record<string, unknown>;

const asRecord = (value: unknown): WorkspaceImportRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as WorkspaceImportRecord;
};

const sanitizeWorkspaceViewMode = (value: unknown): Workspace['viewMode'] =>
  value === 'list' || value === 'grid' || value === 'column' ? value : 'list';

const sanitizeWorkspaceFilterMode = (value: unknown): Workspace['filterMode'] =>
  value === 'all' || value === 'folders' || value === 'files' ? value : 'all';

const sanitizeWorkspaceSortKey = (value: unknown): Workspace['sortKey'] =>
  typeof value === 'string' && value ? value : 'name';

const sanitizeWorkspaceSortDir = (value: unknown): Workspace['sortDir'] =>
  value === 'desc' ? 'desc' : 'asc';

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const sanitizeWorkspaceName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return trimmed;
};

const sanitizeWorkspacePath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (!value || value.includes('\0')) return null;
  return value;
};

const sanitizeWorkspaceTabs = (value: unknown): WorkspaceTab[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as { id?: unknown; path?: unknown };
    const path = sanitizeWorkspacePath(raw.path);
    if (!path) return [];
    const id =
      typeof raw.id === 'string' && raw.id && !raw.id.includes('\0') ? raw.id : `tab-${index}`;
    return [{ id, path }];
  });
};

const buildImportedWorkspace = (value: unknown, id: string, now: number): Workspace | null => {
  const parsed = asRecord(value);
  if (!parsed) return null;
  const name = sanitizeWorkspaceName(parsed.name);
  const tabs = sanitizeWorkspaceTabs(parsed.tabs);
  if (!name || tabs.length === 0) return null;

  const activeTabCandidate = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : '';
  const activeTabId = tabs.some((tab) => tab.id === activeTabCandidate)
    ? activeTabCandidate
    : (tabs[0]?.id ?? '');

  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    tabs,
    activeTabId,
    viewMode: sanitizeWorkspaceViewMode(parsed.viewMode),
    sortKey: sanitizeWorkspaceSortKey(parsed.sortKey),
    sortDir: sanitizeWorkspaceSortDir(parsed.sortDir),
    showHidden: Boolean(parsed.showHidden),
    filterMode: sanitizeWorkspaceFilterMode(parsed.filterMode),
    showPreviewPanel: Boolean(parsed.showPreviewPanel),
    gridMinWidth: optionalNumber(parsed.gridMinWidth) ?? 140,
    windowWidth: optionalNumber(parsed.windowWidth),
    windowHeight: optionalNumber(parsed.windowHeight),
    windowX: optionalNumber(parsed.windowX),
    windowY: optionalNumber(parsed.windowY),
    sidebarWidth: optionalNumber(parsed.sidebarWidth),
    sidebarCollapsed: optionalBoolean(parsed.sidebarCollapsed),
  };
};

export const createWorkspaceSlice: StateCreator<StoreState, [], [], WorkspaceSlice> = (
  set,
  get
) => ({
  workspaces: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:workspaces');
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return {};
  })(),
  lastWorkspaceId: (() => {
    try {
      if (typeof window !== 'undefined') {
        return window.localStorage.getItem('explorie:lastWorkspaceId');
      }
    } catch {}
    return null;
  })(),
  saveWorkspace: (name, tabs, activeTabId, windowState, sidebarState) => {
    const state = get();
    const id = `workspace-${Date.now()}`;
    const now = Date.now();
    const workspace: Workspace = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      tabs,
      activeTabId,
      viewMode: state.viewMode as 'list' | 'grid' | 'column',
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      showHidden: state.showHidden,
      filterMode: state.filterMode,
      showPreviewPanel: state.showPreviewPanel,
      gridMinWidth: state.gridMinWidth,
      windowWidth: windowState?.width,
      windowHeight: windowState?.height,
      windowX: windowState?.x,
      windowY: windowState?.y,
      sidebarWidth: sidebarState?.width,
      sidebarCollapsed: sidebarState?.collapsed,
    };
    const next = { ...state.workspaces, [id]: workspace };
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:workspaces', JSON.stringify(next));
      }
    } catch {}
    set({ workspaces: next, lastWorkspaceId: id });
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:lastWorkspaceId', id);
      }
    } catch {}
    return workspace;
  },
  loadWorkspace: (id: string) => {
    const state = get();
    const workspace = state.workspaces[id];
    if (!workspace) return null;
    set({
      viewMode: workspace.viewMode,
      sortKey: workspace.sortKey as SortKey,
      sortDir: workspace.sortDir as SortDir,
      showHidden: workspace.showHidden,
      filterMode: workspace.filterMode,
      showPreviewPanel: workspace.showPreviewPanel,
      gridMinWidth: workspace.gridMinWidth,
      lastWorkspaceId: id,
    });
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:viewMode', workspace.viewMode);
        window.localStorage.setItem('explorie:sortKey', workspace.sortKey);
        window.localStorage.setItem('explorie:sortDir', workspace.sortDir);
        window.localStorage.setItem('explorie:showHidden', String(workspace.showHidden));
        window.localStorage.setItem('explorie:filterMode', workspace.filterMode);
        window.localStorage.setItem(
          'explorie:showPreviewPanel',
          String(workspace.showPreviewPanel)
        );
        window.localStorage.setItem('explorie:gridMinWidth', String(workspace.gridMinWidth));
        window.localStorage.setItem('explorie:lastWorkspaceId', id);
      }
    } catch {}
    return workspace;
  },
  deleteWorkspace: (id: string) => {
    const state = get();
    const next = { ...state.workspaces };
    delete next[id];
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:workspaces', JSON.stringify(next));
      }
    } catch {}
    set({ workspaces: next });
    if (state.lastWorkspaceId === id) {
      set({ lastWorkspaceId: null });
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.removeItem('explorie:lastWorkspaceId');
        }
      } catch {}
    }
  },
  renameWorkspace: (id: string, newName: string) => {
    const state = get();
    const workspace = state.workspaces[id];
    if (!workspace) return;
    const updated = { ...workspace, name: newName, updatedAt: Date.now() };
    const next = { ...state.workspaces, [id]: updated };
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:workspaces', JSON.stringify(next));
      }
    } catch {}
    set({ workspaces: next });
  },
  getWorkspaceList: () => {
    const state = get();
    return Object.values(state.workspaces).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  smartFolders: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:smartFolders');
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return {};
  })(),
  activeSmartFolderId: null,
  addSmartFolder: (name: string, criteria: SmartFolderCriteria) => {
    const id = `smartfolder-${Date.now()}`;
    const now = Date.now();
    const smartFolder: SmartFolder = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      criteria,
    };
    const state = get();
    const next = { ...state.smartFolders, [id]: smartFolder };
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:smartFolders', JSON.stringify(next));
      }
    } catch {}
    set({ smartFolders: next });
    return smartFolder;
  },
  updateSmartFolder: (
    id: string,
    updates: Partial<Pick<SmartFolder, 'name' | 'icon' | 'criteria'>>
  ) => {
    const state = get();
    const smartFolder = state.smartFolders[id];
    if (!smartFolder) return;
    const updated = { ...smartFolder, ...updates, updatedAt: Date.now() };
    const next = { ...state.smartFolders, [id]: updated };
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:smartFolders', JSON.stringify(next));
      }
    } catch {}
    set({ smartFolders: next });
  },
  deleteSmartFolder: (id: string) => {
    const state = get();
    const next = { ...state.smartFolders };
    delete next[id];
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:smartFolders', JSON.stringify(next));
      }
    } catch {}
    set({
      smartFolders: next,
      activeSmartFolderId: state.activeSmartFolderId === id ? null : state.activeSmartFolderId,
    });
  },
  getSmartFolderList: () => {
    const state = get();
    return Object.values(state.smartFolders).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  setActiveSmartFolderId: (id: string | null) => {
    set({ activeSmartFolderId: id });
  },
  exportWorkspace: (id: string) => {
    const state = get();
    const workspace = state.workspaces[id];
    if (!workspace) return null;
    try {
      return JSON.stringify(workspace, null, 2);
    } catch {
      return null;
    }
  },
  importWorkspace: (jsonString: string) => {
    try {
      const parsed = JSON.parse(jsonString);
      const id = `workspace-${Date.now()}`;
      const now = Date.now();
      const workspace = buildImportedWorkspace(parsed, id, now);
      if (!workspace) return null;
      const state = get();
      const next = { ...state.workspaces, [id]: workspace };
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:workspaces', JSON.stringify(next));
        }
      } catch {}
      set({ workspaces: next });
      return workspace;
    } catch {
      return null;
    }
  },
  exportAllWorkspaces: () => {
    const state = get();
    const workspaceList = Object.values(state.workspaces);
    try {
      return JSON.stringify(workspaceList, null, 2);
    } catch {
      return '[]';
    }
  },
  importAllWorkspaces: (jsonString: string) => {
    try {
      const parsed = JSON.parse(jsonString);
      if (!Array.isArray(parsed)) return 0;
      let importedCount = 0;
      const state = get();
      const newWorkspaces = { ...state.workspaces };
      for (const item of parsed) {
        const id = `workspace-${Date.now()}-${importedCount}`;
        const now = Date.now();
        const workspace = buildImportedWorkspace(item, id, now);
        if (!workspace) continue;
        newWorkspaces[id] = workspace;
        importedCount++;
      }
      if (importedCount > 0) {
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('explorie:workspaces', JSON.stringify(newWorkspaces));
          }
        } catch {}
        set({ workspaces: newWorkspaces });
      }
      return importedCount;
    } catch {
      return 0;
    }
  },
});
