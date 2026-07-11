import type { StateCreator } from 'zustand';
import type { FileSlice, StoreState } from '../types';

export const createFileSlice: StateCreator<StoreState, [], [], FileSlice> = (set) => ({
  files: [],
  loading: false,
  error: null,
  showHidden: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:showHidden');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  showSystemFiles: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:showSystemFiles');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false; // Hide system files by default
  })(),
  searchQuery: '',
  filterMode: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:filterMode');
        if (v === 'all' || v === 'folders' || v === 'files') return v;
      }
    } catch {}
    return 'all';
  })(),
  showFolderSizes: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:showFolderSizes');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  previewExecutableScripts: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:previewExecutableScripts');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  confirmBeforeDelete: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:confirmBeforeDelete');
        if (v === 'false') return false;
      }
    } catch {}
    return true;
  })(),
  sortKey: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:sortKey');
        if (v) return v as StoreState['sortKey'];
      }
    } catch {}
    return 'name';
  })(),
  sortDir: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:sortDir');
        if (v === 'asc' || v === 'desc') return v;
      }
    } catch {}
    return 'asc';
  })(),
  pathStack: ['.'],
  editingId: null,
  draftNew: null,
  clipboard: null,
  selectedPaths: [],
  selectionCursorPath: null,
  setPathStack: (stack) => set({ pathStack: stack }),
  setEditingId: (id) => set({ editingId: id }),
  setDraftNew: (draft) => set({ draftNew: draft }),
  setClipboard: (clip) => set({ clipboard: clip }),
  setSelectedPaths: (paths) => set({ selectedPaths: [...new Set(paths)] }),
  setSelectionCursorPath: (path) => set({ selectionCursorPath: path }),
  clearSelection: () => set({ selectedPaths: [], selectionCursorPath: null }),
  setFiles: (files) =>
    set((state) => ({
      files: typeof files === 'function' ? files(state.files) : files,
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setShowHidden: (show) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:showHidden', String(show));
      }
    } catch {}
    set({ showHidden: show });
  },
  setShowSystemFiles: (show) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:showSystemFiles', String(show));
      }
    } catch {}
    set({ showSystemFiles: show });
  },
  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilterMode: (mode) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:filterMode', mode);
      }
    } catch {}
    set({ filterMode: mode });
  },
  setShowFolderSizes: (show) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:showFolderSizes', String(show));
      }
    } catch {}
    set({ showFolderSizes: show });
  },
  setPreviewExecutableScripts: (allow) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:previewExecutableScripts', String(allow));
      }
    } catch {}
    set({ previewExecutableScripts: allow });
  },
  setConfirmBeforeDelete: (v) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:confirmBeforeDelete', String(v));
      }
    } catch {}
    set({ confirmBeforeDelete: v });
  },
  setSort: (key) => {
    set((state) => {
      const nextDir = state.sortKey === key ? (state.sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:sortKey', String(key));
          window.localStorage.setItem('explorie:sortDir', nextDir);
        }
      } catch {}
      return { sortKey: key, sortDir: nextDir };
    });
  },
  setSortDir: (dir) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:sortDir', dir);
      }
    } catch {}
    set({ sortDir: dir });
  },
});
