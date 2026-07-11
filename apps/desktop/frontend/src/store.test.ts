import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileStore, type FileEntry, type SmartFolderCriteria, type ThemeSpec } from './store';
import type { StoreState } from './store/types';
import { normalizeThemeSpec } from './store/slices/uiSlice';

const initialState = useFileStore.getState();

const textFile: FileEntry = {
  id: 'file-1',
  path: '/root/a.txt',
  name: 'a.txt',
  size: 10,
  modified: 1,
  is_dir: false,
  custom: {},
};

const imageFile: FileEntry = {
  id: 'file-2',
  path: '/root/b.png',
  name: 'b.png',
  size: 20,
  modified: 2,
  is_dir: false,
  custom: {},
};

const criteria: SmartFolderCriteria = {
  searchPaths: ['/root'],
  recursive: true,
  extensions: ['txt'],
  typeFilter: 'files',
};

const themeSpec: ThemeSpec = {
  theme: 'light',
  accent: 'pink',
  accentCustom: '#ff00aa',
  density: 'compact',
  uiScale: 1.2,
  listRowHeight: 44,
  gridMinWidth: 220,
  font: 'custom',
  fontCustom: 'Inter',
  borderRadius: 8,
  iconSize: 20,
  reduceMotion: true,
};

function resetStore(overrides: Partial<StoreState> = {}) {
  useFileStore.setState(
    {
      ...initialState,
      files: [],
      loading: false,
      error: null,
      showHidden: false,
      showSystemFiles: false,
      searchQuery: '',
      filterMode: 'all',
      showFolderSizes: false,
      previewExecutableScripts: false,
      confirmBeforeDelete: true,
      sortKey: 'name',
      sortDir: 'asc',
      pathStack: ['.'],
      editingId: null,
      draftNew: null,
      clipboard: null,
      viewMode: 'list',
      theme: 'dark',
      accent: 'blue',
      accentCustom: '#7cc7ff',
      density: 'comfortable',
      uiScale: 1,
      listRowHeight: 34,
      gridMinWidth: 140,
      font: 'mono',
      fontCustom: '',
      borderRadius: 0,
      iconSize: 14,
      reduceMotion: false,
      highContrast: false,
      enableErrorReporting: false,
      showPreviewPanel: false,
      showStatusBar: true,
      themes: {},
      favorites: [],
      workspaces: {},
      lastWorkspaceId: null,
      smartFolders: {},
      activeSmartFolderId: null,
      ...overrides,
    },
    true
  );
}

describe('useFileStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    localStorage.clear();
    resetStore();
  });

  it('adds favorites and avoids duplicates', () => {
    const { addFavorite } = useFileStore.getState();
    addFavorite('/root/docs');
    addFavorite('/root/docs/');
    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(1);
    expect(favorites[0].path).toBe('/root/docs');
  });

  it('renames favorites', () => {
    const { addFavorite, renameFavorite } = useFileStore.getState();
    addFavorite('/root/docs', 'Docs');
    renameFavorite('/root/docs', 'Documents');
    const favorites = useFileStore.getState().favorites;
    expect(favorites[0].name).toBe('Documents');
  });

  it('removes and reorders favorites while persisting them', () => {
    const { addFavorite, removeFavorite, reorderFavorites } = useFileStore.getState();
    addFavorite('/root/docs', 'Docs');
    addFavorite('/root/images', 'Images');

    removeFavorite('/root/docs/');
    expect(useFileStore.getState().favorites).toEqual([{ path: '/root/images', name: 'Images' }]);

    reorderFavorites([
      { path: '/root/music', name: 'Music' },
      { path: '/root/images', name: 'Images' },
    ]);

    expect(useFileStore.getState().favorites.map((favorite) => favorite.name)).toEqual([
      'Music',
      'Images',
    ]);
    expect(JSON.parse(localStorage.getItem('explorie:favorites') || '[]')).toEqual([
      { path: '/root/music', name: 'Music' },
      { path: '/root/images', name: 'Images' },
    ]);
  });

  it('updates file state and persists file preferences', () => {
    const store = useFileStore.getState();
    store.setPathStack(['/root', '/root/docs']);
    store.setFiles([textFile]);
    store.setFiles((files) => [...files, imageFile]);
    store.setLoading(true);
    store.setError('Failed');
    store.setShowHidden(true);
    store.setShowSystemFiles(true);
    store.setSearchQuery('invoice');
    store.setFilterMode('files');
    store.setShowFolderSizes(true);
    store.setPreviewExecutableScripts(true);
    store.setConfirmBeforeDelete(false);
    store.setEditingId('file-1');
    store.setDraftNew({ id: 'draft-1', parentPath: '/root', name: 'New Folder' });
    store.setClipboard({ mode: 'cut', items: [textFile], sourcePath: '/root' });
    store.setSortDir('desc');

    expect(useFileStore.getState()).toMatchObject({
      pathStack: ['/root', '/root/docs'],
      files: [textFile, imageFile],
      loading: true,
      error: 'Failed',
      showHidden: true,
      showSystemFiles: true,
      searchQuery: 'invoice',
      filterMode: 'files',
      showFolderSizes: true,
      previewExecutableScripts: true,
      confirmBeforeDelete: false,
      editingId: 'file-1',
      draftNew: { id: 'draft-1', parentPath: '/root', name: 'New Folder' },
      clipboard: { mode: 'cut', items: [textFile], sourcePath: '/root' },
      sortDir: 'desc',
    });
    expect(localStorage.getItem('explorie:showHidden')).toBe('true');
    expect(localStorage.getItem('explorie:showSystemFiles')).toBe('true');
    expect(localStorage.getItem('explorie:filterMode')).toBe('files');
    expect(localStorage.getItem('explorie:showFolderSizes')).toBe('true');
    expect(localStorage.getItem('explorie:previewExecutableScripts')).toBe('true');
    expect(localStorage.getItem('explorie:confirmBeforeDelete')).toBe('false');
    expect(localStorage.getItem('explorie:sortDir')).toBe('desc');
  });

  it('toggles sort direction when sorting by the same key', () => {
    const { setSort } = useFileStore.getState();
    setSort('name');
    expect(useFileStore.getState().sortDir).toBe('desc');
    setSort('name');
    expect(useFileStore.getState().sortDir).toBe('asc');
  });

  it('updates UI preferences with clamping and localStorage persistence', () => {
    const store = useFileStore.getState();

    store.setViewMode('grid');
    store.setTheme('light');
    store.setAccent('green');
    store.setAccentCustom('ff00aa');
    store.setDensity('compact');
    store.setUiScale(2);
    store.setListRowHeight(100);
    store.setGridMinWidth(20);
    store.setFont('serif');
    store.setFontCustom('JetBrains Mono');
    store.setBorderRadius(4);
    store.setIconSize(1);
    store.setReduceMotion(true);
    store.setHighContrast(true);
    store.setEnableErrorReporting(true);
    store.setShowPreviewPanel(true);
    store.setShowStatusBar(false);

    expect(useFileStore.getState()).toMatchObject({
      viewMode: 'grid',
      theme: 'light',
      accent: 'custom',
      accentCustom: '#ff00aa',
      density: 'compact',
      uiScale: 1.4,
      listRowHeight: 52,
      gridMinWidth: 120,
      font: 'custom',
      fontCustom: 'JetBrains Mono',
      borderRadius: 4,
      iconSize: 10,
      reduceMotion: true,
      highContrast: true,
      enableErrorReporting: true,
      showPreviewPanel: true,
      showStatusBar: false,
    });
    expect(localStorage.getItem('explorie:viewMode')).toBe('grid');
    expect(localStorage.getItem('explorie:accentCustom')).toBe('#ff00aa');
    expect(localStorage.getItem('explorie:uiScale')).toBe('1.4');
    expect(localStorage.getItem('explorie:listRowHeight')).toBe('52');
    expect(localStorage.getItem('explorie:gridMinWidth')).toBe('120');
    expect(localStorage.getItem('explorie:iconSize')).toBe('10');
  });

  it('saves, deletes, and applies theme specs', () => {
    const store = useFileStore.getState();

    store.setTheme('system');
    store.setAccent('orange');
    store.saveTheme('Current');
    expect(useFileStore.getState().themes.Current).toMatchObject({
      theme: 'system',
      accent: 'orange',
    });

    store.saveTheme('Bright', themeSpec);
    expect(useFileStore.getState().themes.Bright).toEqual(themeSpec);

    store.applyThemeSpec(themeSpec);
    expect(useFileStore.getState()).toMatchObject({
      theme: 'light',
      accent: 'pink',
      density: 'compact',
      font: 'custom',
      fontCustom: 'Inter',
      borderRadius: 8,
    });
    expect(localStorage.getItem('explorie:theme')).toBe('light');

    store.deleteTheme('Current');
    expect(useFileStore.getState().themes.Current).toBeUndefined();
  });

  it('normalizes valid theme values and rejects invalid field types', () => {
    expect(
      normalizeThemeSpec({
        ...themeSpec,
        uiScale: 5,
        listRowHeight: 10,
        gridMinWidth: 999,
        iconSize: 2,
      })
    ).toMatchObject({
      uiScale: 1.4,
      listRowHeight: 26,
      gridMinWidth: 260,
      iconSize: 10,
    });
    expect(normalizeThemeSpec({ ...themeSpec, accent: 'unsafe' })).toBeNull();
    expect(normalizeThemeSpec({ ...themeSpec, reduceMotion: 'false' })).toBeNull();
  });

  it('saves, loads, renames, sorts, exports, and deletes workspaces', () => {
    resetStore({
      viewMode: 'grid',
      sortKey: 'size',
      sortDir: 'desc',
      showHidden: true,
      filterMode: 'folders',
      showPreviewPanel: true,
      gridMinWidth: 180,
    });
    const store = useFileStore.getState();

    const first = store.saveWorkspace(
      'Design',
      [
        { id: 'tab-1', path: '/root/design' },
        { id: 'tab-2', path: '/root/assets' },
      ],
      'tab-2',
      { width: 1000, height: 700, x: 10, y: 20 },
      { width: 260, collapsed: true }
    );
    expect(first).toMatchObject({
      id: 'workspace-1780488000000',
      name: 'Design',
      viewMode: 'grid',
      sortKey: 'size',
      sortDir: 'desc',
      showHidden: true,
      filterMode: 'folders',
      showPreviewPanel: true,
      gridMinWidth: 180,
      windowWidth: 1000,
      sidebarCollapsed: true,
    });
    expect(localStorage.getItem('explorie:lastWorkspaceId')).toBe(first.id);

    vi.advanceTimersByTime(1000);
    const second = useFileStore
      .getState()
      .saveWorkspace('Review', [{ id: 'tab-3', path: '/root/review' }], 'tab-3');
    expect(
      useFileStore
        .getState()
        .getWorkspaceList()
        .map((workspace) => workspace.name)
    ).toEqual(['Review', 'Design']);

    resetStore({
      ...useFileStore.getState(),
      viewMode: 'list',
      sortKey: 'name',
      sortDir: 'asc',
      showHidden: false,
      filterMode: 'all',
      showPreviewPanel: false,
      gridMinWidth: 140,
    });
    expect(useFileStore.getState().loadWorkspace(first.id)).toEqual(first);
    expect(useFileStore.getState()).toMatchObject({
      viewMode: 'grid',
      sortKey: 'size',
      sortDir: 'desc',
      showHidden: true,
      filterMode: 'folders',
      showPreviewPanel: true,
      gridMinWidth: 180,
      lastWorkspaceId: first.id,
    });
    expect(localStorage.getItem('explorie:viewMode')).toBe('grid');
    expect(useFileStore.getState().loadWorkspace('missing')).toBeNull();

    vi.advanceTimersByTime(1000);
    useFileStore.getState().renameWorkspace(first.id, 'Design System');
    expect(useFileStore.getState().workspaces[first.id].name).toBe('Design System');
    useFileStore.getState().renameWorkspace('missing', 'Ignored');

    expect(JSON.parse(useFileStore.getState().exportWorkspace(first.id) || '{}')).toMatchObject({
      id: first.id,
      name: 'Design System',
    });
    expect(useFileStore.getState().exportWorkspace('missing')).toBeNull();

    useFileStore.getState().deleteWorkspace(first.id);
    expect(useFileStore.getState().workspaces[first.id]).toBeUndefined();
    expect(useFileStore.getState().lastWorkspaceId).toBeNull();
    expect(useFileStore.getState().workspaces[second.id]).toBeDefined();
  });

  it('sanitizes imported workspaces and rejects invalid payloads', () => {
    const validJson = JSON.stringify({
      name: ' Imported Workspace ',
      activeTabId: 'missing',
      tabs: [
        { id: 'bad', path: '' },
        { id: 'tab\0bad', path: '/root/imported' },
      ],
      viewMode: 'invalid',
      sortKey: '',
      sortDir: 'sideways',
      showHidden: 'yes',
      filterMode: 'invalid',
      showPreviewPanel: 1,
      gridMinWidth: 200,
      windowWidth: 900,
      windowHeight: 'bad',
      sidebarCollapsed: true,
    });

    expect(useFileStore.getState().importWorkspace('{')).toBeNull();
    expect(
      useFileStore.getState().importWorkspace(JSON.stringify({ name: '', tabs: [] }))
    ).toBeNull();

    const imported = useFileStore.getState().importWorkspace(validJson);
    expect(imported).toMatchObject({
      id: 'workspace-1780488000000',
      name: 'Imported Workspace',
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', path: '/root/imported' }],
      viewMode: 'list',
      sortKey: 'name',
      sortDir: 'asc',
      showHidden: true,
      filterMode: 'all',
      showPreviewPanel: true,
      gridMinWidth: 200,
      windowWidth: 900,
      sidebarCollapsed: true,
    });
    expect(useFileStore.getState().workspaces[imported?.id || '']).toEqual(imported);
  });

  it('imports and exports workspace batches', () => {
    const count = useFileStore.getState().importAllWorkspaces(
      JSON.stringify([
        { name: 'One', tabs: [{ path: '/one' }] },
        { name: 'Invalid', tabs: [] },
        { name: 'Two', tabs: [{ id: 'two-tab', path: '/two' }], activeTabId: 'two-tab' },
      ])
    );

    expect(count).toBe(2);
    expect(useFileStore.getState().importAllWorkspaces('{}')).toBe(0);
    expect(useFileStore.getState().importAllWorkspaces('{')).toBe(0);

    const exported = JSON.parse(useFileStore.getState().exportAllWorkspaces());
    expect(exported.map((workspace: { name: string }) => workspace.name)).toEqual(['One', 'Two']);
    expect(Object.keys(useFileStore.getState().workspaces)).toEqual([
      'workspace-1780488000000-0',
      'workspace-1780488000000-1',
    ]);
  });

  it('adds, updates, sorts, activates, and deletes smart folders', () => {
    const first = useFileStore.getState().addSmartFolder('Text Files', criteria);
    vi.advanceTimersByTime(1000);
    const second = useFileStore.getState().addSmartFolder('Images', {
      searchPaths: ['/root/images'],
      typeFilter: 'files',
      extensions: ['png'],
    });

    expect(
      useFileStore
        .getState()
        .getSmartFolderList()
        .map((folder) => folder.name)
    ).toEqual(['Images', 'Text Files']);

    vi.advanceTimersByTime(1000);
    useFileStore.getState().updateSmartFolder(first.id, {
      name: 'Source Text',
      icon: 'doc',
      criteria: { ...criteria, namePattern: 'README' },
    });
    useFileStore.getState().updateSmartFolder('missing', { name: 'Ignored' });
    useFileStore.getState().setActiveSmartFolderId(first.id);

    expect(useFileStore.getState().smartFolders[first.id]).toMatchObject({
      name: 'Source Text',
      icon: 'doc',
      criteria: { ...criteria, namePattern: 'README' },
    });
    expect(useFileStore.getState().activeSmartFolderId).toBe(first.id);
    expect(JSON.parse(localStorage.getItem('explorie:smartFolders') || '{}')[first.id].name).toBe(
      'Source Text'
    );

    useFileStore.getState().deleteSmartFolder(first.id);
    expect(useFileStore.getState().smartFolders[first.id]).toBeUndefined();
    expect(useFileStore.getState().smartFolders[second.id]).toBeDefined();
    expect(useFileStore.getState().activeSmartFolderId).toBeNull();
  });
});
