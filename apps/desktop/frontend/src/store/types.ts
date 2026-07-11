import type { ViewMode } from '../components/ViewModeToggle';
import type { SortKey, SortDir } from '../components/FileTable';
import type { CustomFields } from '../utils/customFieldTypes';

export type ThemeMode = 'dark' | 'light' | 'system';
export type AccentColor = 'blue' | 'green' | 'purple' | 'orange' | 'pink' | 'custom';
export type Density = 'comfortable' | 'compact';
export type FontChoice = 'mono' | 'system' | 'serif' | 'custom';
export type BorderRadius = 0 | 4 | 8;

export type FileModified =
  | string
  | number
  | { secs_since_epoch: number; nanos_since_epoch?: number };

export interface FileEntry {
  id: string;
  path: string;
  name?: string; // precomputed basename for performance
  size: number;
  // Backend can send Rust SystemTime (object) or ISO string/epoch.
  // Normalize at use sites via utils/date.ts helpers.
  modified: FileModified;
  hidden?: boolean;
  is_dir: boolean;
  custom: CustomFields;
  // Transient draft item (e.g., new folder being named)
  is_draft?: boolean;
  // Symlink/junction support
  is_symlink?: boolean;
  is_junction?: boolean;
  link_target?: string;
  // Extended attributes (macOS xattrs, Windows ADS)
  has_xattrs?: boolean;
}

export type ThemeSpec = {
  theme: ThemeMode;
  accent: AccentColor;
  accentCustom: string;
  density: Density;
  uiScale: number;
  listRowHeight: number;
  gridMinWidth: number;
  font: FontChoice;
  fontCustom?: string;
  borderRadius: BorderRadius;
  iconSize: number;
  reduceMotion: boolean;
};

export type FavoriteItem = {
  path: string;
  name: string; // display name (defaults to folder name)
};

export type WorkspaceTab = {
  id: string;
  path: string;
};

export type Workspace = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tabs: WorkspaceTab[];
  activeTabId: string;
  viewMode: 'list' | 'grid' | 'column';
  sortKey: string;
  sortDir: 'asc' | 'desc';
  showHidden: boolean;
  filterMode: 'all' | 'folders' | 'files';
  showPreviewPanel: boolean;
  gridMinWidth: number;
  windowWidth?: number;
  windowHeight?: number;
  windowX?: number;
  windowY?: number;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
};

export type SmartFolderCriteria = {
  namePattern?: string;
  nameRegex?: boolean;
  extensions?: string[];
  typeFilter?: 'files' | 'folders' | 'all';
  sizeMin?: number;
  sizeMax?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  contentSearch?: string;
  searchPaths: string[];
  recursive?: boolean;
  combineMode?: 'AND' | 'OR';
  excludePattern?: string;
};

export type SmartFolder = {
  id: string;
  name: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  criteria: SmartFolderCriteria;
  lastRefreshed?: number;
  cachedResults?: FileEntry[];
};

export interface FileSlice {
  files: FileEntry[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  showSystemFiles: boolean; // Show .DS_Store, Thumbs.db, etc.
  searchQuery: string;
  filterMode: 'all' | 'folders' | 'files';
  showFolderSizes: boolean;
  previewExecutableScripts: boolean;
  confirmBeforeDelete: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  pathStack: string[];
  editingId: string | null;
  draftNew: { id: string; parentPath: string; name: string } | null;
  clipboard: { mode: 'copy' | 'cut'; items: FileEntry[]; sourcePath: string } | null;
  selectedPaths: string[];
  selectionCursorPath: string | null;
  setPathStack: (stack: string[]) => void;
  setFiles: (files: FileEntry[] | ((prev: FileEntry[]) => FileEntry[])) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setShowHidden: (show: boolean) => void;
  setShowSystemFiles: (show: boolean) => void;
  setSearchQuery: (q: string) => void;
  setFilterMode: (mode: 'all' | 'folders' | 'files') => void;
  setShowFolderSizes: (show: boolean) => void;
  setPreviewExecutableScripts: (allow: boolean) => void;
  setConfirmBeforeDelete: (v: boolean) => void;
  setSort: (key: SortKey) => void;
  setSortDir: (dir: SortDir) => void;
  setEditingId: (id: string | null) => void;
  setDraftNew: (draft: { id: string; parentPath: string; name: string } | null) => void;
  setClipboard: (
    clip: { mode: 'copy' | 'cut'; items: FileEntry[]; sourcePath: string } | null
  ) => void;
  setSelectedPaths: (paths: string[]) => void;
  setSelectionCursorPath: (path: string | null) => void;
  clearSelection: () => void;
}

export interface UISlice {
  viewMode: ViewMode;
  theme: ThemeMode;
  accent: AccentColor;
  accentCustom: string;
  density: Density;
  uiScale: number;
  listRowHeight: number;
  gridMinWidth: number;
  font: FontChoice;
  fontCustom: string;
  borderRadius: BorderRadius;
  iconSize: number;
  reduceMotion: boolean;
  highContrast: boolean;
  enableErrorReporting: boolean;
  showPreviewPanel: boolean;
  showStatusBar: boolean;
  themes: Record<string, ThemeSpec>;
  setViewMode: (mode: ViewMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: AccentColor) => void;
  setAccentCustom: (hex: string) => void;
  setDensity: (d: Density) => void;
  setUiScale: (scale: number) => void;
  setListRowHeight: (h: number) => void;
  setGridMinWidth: (w: number) => void;
  setFont: (f: FontChoice) => void;
  setFontCustom: (s: string) => void;
  setBorderRadius: (r: BorderRadius) => void;
  setIconSize: (n: number) => void;
  setReduceMotion: (v: boolean) => void;
  setHighContrast: (v: boolean) => void;
  setEnableErrorReporting: (v: boolean) => void;
  setShowPreviewPanel: (show: boolean) => void;
  setShowStatusBar: (show: boolean) => void;
  saveTheme: (name: string, spec?: ThemeSpec) => void;
  deleteTheme: (name: string) => void;
  applyThemeSpec: (spec: ThemeSpec) => void;
}

export interface FavoritesSlice {
  favorites: FavoriteItem[];
  addFavorite: (path: string, name?: string) => void;
  removeFavorite: (path: string) => void;
  renameFavorite: (path: string, newName: string) => void;
  reorderFavorites: (favorites: FavoriteItem[]) => void;
}

export interface WorkspaceSlice {
  workspaces: Record<string, Workspace>;
  lastWorkspaceId: string | null;
  saveWorkspace: (
    name: string,
    tabs: WorkspaceTab[],
    activeTabId: string,
    windowState?: { width?: number; height?: number; x?: number; y?: number },
    sidebarState?: { width?: number; collapsed?: boolean }
  ) => Workspace;
  loadWorkspace: (id: string) => Workspace | null;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, newName: string) => void;
  getWorkspaceList: () => Workspace[];
  smartFolders: Record<string, SmartFolder>;
  activeSmartFolderId: string | null;
  addSmartFolder: (name: string, criteria: SmartFolderCriteria) => SmartFolder;
  updateSmartFolder: (
    id: string,
    updates: Partial<Pick<SmartFolder, 'name' | 'icon' | 'criteria'>>
  ) => void;
  deleteSmartFolder: (id: string) => void;
  getSmartFolderList: () => SmartFolder[];
  setActiveSmartFolderId: (id: string | null) => void;
  exportWorkspace: (id: string) => string | null;
  importWorkspace: (jsonString: string) => Workspace | null;
  exportAllWorkspaces: () => string;
  importAllWorkspaces: (jsonString: string) => number;
}

export type StoreState = FileSlice & UISlice & FavoritesSlice & WorkspaceSlice;
