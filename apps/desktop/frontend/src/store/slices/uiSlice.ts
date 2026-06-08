import { invoke, isTauri } from '@tauri-apps/api/core';
import type { StateCreator } from 'zustand';
import type {
  StoreState,
  UISlice,
  ThemeSpec,
  ImportedFont,
  ThemeMode,
  AccentColor,
  Density,
  FontChoice,
  BorderRadius,
} from '../types';
import type { ViewMode } from '../../components/ViewModeToggle';

const isWindowsPlatform = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);
const isTauriRuntime = () => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};
const isDefaultExplorerAvailable = () => isWindowsPlatform && isTauriRuntime();

export const createUISlice: StateCreator<StoreState, [], [], UISlice> = (set) => ({
  viewMode: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:viewMode');
        if (v === 'list' || v === 'column' || v === 'grid') return v as ViewMode;
      }
    } catch {}
    return 'list';
  })(),
  theme: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:theme');
        if (v === 'dark' || v === 'light' || v === 'system') return v as ThemeMode;
      }
    } catch {}
    return 'dark' as ThemeMode;
  })(),
  accent: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:accent');
        if (
          v === 'blue' ||
          v === 'green' ||
          v === 'purple' ||
          v === 'orange' ||
          v === 'pink' ||
          v === 'custom'
        )
          return v as AccentColor;
      }
    } catch {}
    return 'blue' as AccentColor;
  })(),
  accentCustom: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:accentCustom');
        if (v && /^#?[0-9A-Fa-f]{6}$/.test(v)) return v.startsWith('#') ? v : `#${v}`;
      }
    } catch {}
    return '#7cc7ff';
  })(),
  density: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:density');
        if (v === 'comfortable' || v === 'compact') return v as Density;
      }
    } catch {}
    return 'comfortable' as Density;
  })(),
  uiScale: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = parseFloat(window.localStorage.getItem('explorie:uiScale') || '');
        if (Number.isFinite(v) && v >= 0.8 && v <= 1.4) return v;
      }
    } catch {}
    return 1.0;
  })(),
  listRowHeight: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = parseInt(window.localStorage.getItem('explorie:listRowHeight') || '');
        if (Number.isFinite(v) && v >= 26 && v <= 52) return v;
      }
    } catch {}
    return 34;
  })(),
  gridMinWidth: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = parseInt(window.localStorage.getItem('explorie:gridMinWidth') || '');
        if (Number.isFinite(v) && v >= 120 && v <= 260) return v;
      }
    } catch {}
    return 140;
  })(),
  font: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:font');
        if (v === 'mono' || v === 'system' || v === 'serif' || v === 'custom')
          return v as FontChoice;
      }
    } catch {}
    return 'mono' as FontChoice;
  })(),
  fontCustom: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:fontCustom');
        if (typeof v === 'string') return v;
      }
    } catch {}
    return '';
  })(),
  borderRadius: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = parseInt(window.localStorage.getItem('explorie:borderRadius') || '');
        if (v === 0 || v === 4 || v === 8) return v as BorderRadius;
      }
    } catch {}
    return 0 as BorderRadius;
  })(),
  iconSize: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = parseInt(window.localStorage.getItem('explorie:iconSize') || '');
        if (Number.isFinite(v) && v >= 10 && v <= 24) return v;
      }
    } catch {}
    return 14;
  })(),
  reduceMotion: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:reduceMotion');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  highContrast: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:highContrast');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  enableErrorReporting: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:enableErrorReporting');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false; // Opt-in, defaults to false
  })(),
  importedFonts: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:importedFonts');
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr)
          ? (arr.filter(
              (f: unknown): f is ImportedFont =>
                f !== null &&
                typeof f === 'object' &&
                typeof (f as ImportedFont).name === 'string' &&
                typeof (f as ImportedFont).href === 'string' &&
                typeof (f as ImportedFont).id === 'string'
            ) as ImportedFont[])
          : [];
      }
    } catch {}
    return [] as ImportedFont[];
  })(),
  showPreviewPanel: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:showPreviewPanel');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return false;
  })(),
  showStatusBar: (() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:showStatusBar');
        if (v === 'false') return false;
      }
    } catch {}
    return true;
  })(),
  themes: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:themes');
        if (raw) return JSON.parse(raw);
      }
    } catch {}
    return {};
  })(),
  defaultExplorerSupported: isDefaultExplorerAvailable(),
  defaultExplorerEnabled: null,
  defaultExplorerLoading: false,
  defaultExplorerError: null,
  setViewMode: (mode) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:viewMode', mode);
      }
    } catch {}
    set({ viewMode: mode });
  },
  setTheme: (theme) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:theme', theme);
    } catch {}
    set({ theme });
  },
  setAccent: (accent) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:accent', accent);
    } catch {}
    set({ accent });
  },
  setAccentCustom: (hex) => {
    const norm = hex.startsWith('#') ? hex : `#${hex}`;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:accentCustom', norm);
      }
    } catch {}
    set({ accentCustom: norm, accent: 'custom' });
  },
  setDensity: (d) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:density', d);
    } catch {}
    set({ density: d });
  },
  setUiScale: (v) => {
    const s = Math.min(1.4, Math.max(0.8, v));
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:uiScale', String(s));
    } catch {}
    set({ uiScale: s });
  },
  setListRowHeight: (h) => {
    const v = Math.min(52, Math.max(26, Math.round(h)));
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:listRowHeight', String(v));
    } catch {}
    set({ listRowHeight: v });
  },
  setGridMinWidth: (w) => {
    const v = Math.min(260, Math.max(120, Math.round(w)));
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:gridMinWidth', String(v));
    } catch {}
    set({ gridMinWidth: v });
  },
  setFont: (f) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:font', f);
    } catch {}
    set({ font: f });
  },
  setFontCustom: (s) => {
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem('explorie:fontCustom', s);
    } catch {}
    set({ fontCustom: s, font: 'custom' });
  },
  setBorderRadius: (r) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:borderRadius', String(r));
      }
    } catch {}
    set({ borderRadius: r });
  },
  setIconSize: (n) => {
    const v = Math.min(24, Math.max(10, Math.round(n)));
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:iconSize', String(v));
    } catch {}
    set({ iconSize: v });
  },
  setReduceMotion: (v) => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:reduceMotion', String(v));
    } catch {}
    set({ reduceMotion: v });
  },
  setHighContrast: (v) => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:highContrast', String(v));
    } catch {}
    set({ highContrast: v });
  },
  setEnableErrorReporting: (v) => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:enableErrorReporting', String(v));
    } catch {}
    set({ enableErrorReporting: v });
  },
  addImportedFont: (font: ImportedFont) => {
    set((state) => {
      const exists = (state.importedFonts || []).some(
        (f) => f.id === font.id || f.name.toLowerCase() === font.name.toLowerCase()
      );
      const next = exists ? state.importedFonts : [...(state.importedFonts || []), font];
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:importedFonts', JSON.stringify(next));
        }
      } catch {}
      return { importedFonts: next };
    });
  },
  removeImportedFont: (id) => {
    set((state) => {
      const next = (state.importedFonts || []).filter((f) => f.id !== id);
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:importedFonts', JSON.stringify(next));
        }
      } catch {}
      const removed = (state.importedFonts || []).find((f) => f.id === id);
      const updates: Partial<UISlice> = { importedFonts: next };
      if (
        removed &&
        state.font === 'custom' &&
        state.fontCustom &&
        removed.name.toLowerCase() === String(state.fontCustom).toLowerCase()
      ) {
        updates.font = 'system';
        updates.fontCustom = '';
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('explorie:font', 'system');
            window.localStorage.setItem('explorie:fontCustom', '');
          }
        } catch {}
      }
      return updates;
    });
  },
  setShowPreviewPanel: (show) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:showPreviewPanel', String(show));
      }
    } catch {}
    set({ showPreviewPanel: show });
  },
  setShowStatusBar: (show) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:showStatusBar', String(show));
      }
    } catch {}
    set({ showStatusBar: show });
  },
  refreshDefaultExplorer: async () => {
    if (!isDefaultExplorerAvailable()) {
      set({
        defaultExplorerSupported: false,
        defaultExplorerEnabled: null,
        defaultExplorerLoading: false,
        defaultExplorerError: null,
      });
      return null;
    }
    set({ defaultExplorerSupported: true });
    set({ defaultExplorerLoading: true, defaultExplorerError: null });
    try {
      const value = await invoke<boolean>('is_default_file_manager');
      set({ defaultExplorerEnabled: value, defaultExplorerLoading: false });
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ defaultExplorerLoading: false, defaultExplorerError: message });
      return null;
    }
  },
  makeDefaultExplorer: async () => {
    if (!isDefaultExplorerAvailable()) {
      const message = 'Default explorer integration is only available on Windows.';
      set({
        defaultExplorerSupported: false,
        defaultExplorerLoading: false,
        defaultExplorerError: message,
      });
      throw new Error(message);
    }
    set({ defaultExplorerSupported: true });
    set({ defaultExplorerLoading: true, defaultExplorerError: null });
    try {
      await invoke('set_default_file_manager');
      set({ defaultExplorerEnabled: true, defaultExplorerLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ defaultExplorerLoading: false, defaultExplorerError: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },
  revertDefaultExplorer: async () => {
    if (!isDefaultExplorerAvailable()) {
      const message = 'Default explorer integration is only available on Windows.';
      set({
        defaultExplorerSupported: false,
        defaultExplorerLoading: false,
        defaultExplorerError: message,
      });
      throw new Error(message);
    }
    set({ defaultExplorerSupported: true });
    set({ defaultExplorerLoading: true, defaultExplorerError: null });
    try {
      await invoke('revert_default_file_manager');
      set({ defaultExplorerEnabled: false, defaultExplorerLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ defaultExplorerLoading: false, defaultExplorerError: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },
  clearDefaultExplorerError: () => set({ defaultExplorerError: null }),
  saveTheme: (name: string, spec?: ThemeSpec) => {
    set((state) => {
      const s: ThemeSpec = spec || {
        theme: state.theme,
        accent: state.accent,
        accentCustom: state.accentCustom,
        density: state.density,
        uiScale: state.uiScale,
        listRowHeight: state.listRowHeight,
        gridMinWidth: state.gridMinWidth,
        font: state.font,
        fontCustom: state.fontCustom,
        borderRadius: state.borderRadius,
        iconSize: state.iconSize,
        reduceMotion: state.reduceMotion,
        fonts: state.importedFonts,
      };
      const next = { ...(state.themes || {}), [name]: s } as Record<string, ThemeSpec>;
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:themes', JSON.stringify(next));
        }
      } catch {}
      return { themes: next };
    });
  },
  deleteTheme: (name: string) => {
    set((state) => {
      const next = { ...(state.themes || {}) } as Record<string, ThemeSpec>;
      delete next[name];
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:themes', JSON.stringify(next));
        }
      } catch {}
      return { themes: next };
    });
  },
  applyThemeSpec: (spec: ThemeSpec) => {
    set((state) => {
      const applied: Partial<StoreState> = {
        theme: spec.theme ?? state.theme,
        accent: spec.accent ?? state.accent,
        accentCustom: spec.accentCustom ?? state.accentCustom,
        density: spec.density ?? state.density,
        uiScale: typeof spec.uiScale === 'number' ? spec.uiScale : state.uiScale,
        listRowHeight:
          typeof spec.listRowHeight === 'number' ? spec.listRowHeight : state.listRowHeight,
        gridMinWidth:
          typeof spec.gridMinWidth === 'number' ? spec.gridMinWidth : state.gridMinWidth,
        font: spec.font ?? state.font,
        fontCustom: spec.fontCustom ?? state.fontCustom,
        borderRadius: spec.borderRadius ?? state.borderRadius,
        iconSize: typeof spec.iconSize === 'number' ? spec.iconSize : state.iconSize,
        reduceMotion:
          typeof spec.reduceMotion === 'boolean' ? spec.reduceMotion : state.reduceMotion,
      };
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:theme', String(applied.theme));
          window.localStorage.setItem('explorie:accent', String(applied.accent));
          window.localStorage.setItem('explorie:accentCustom', String(applied.accentCustom));
          window.localStorage.setItem('explorie:density', String(applied.density));
          window.localStorage.setItem('explorie:uiScale', String(applied.uiScale));
          window.localStorage.setItem('explorie:listRowHeight', String(applied.listRowHeight));
          window.localStorage.setItem('explorie:gridMinWidth', String(applied.gridMinWidth));
          window.localStorage.setItem('explorie:font', String(applied.font));
          window.localStorage.setItem('explorie:fontCustom', String(applied.fontCustom ?? ''));
          window.localStorage.setItem('explorie:borderRadius', String(applied.borderRadius));
          window.localStorage.setItem('explorie:iconSize', String(applied.iconSize));
          window.localStorage.setItem('explorie:reduceMotion', String(applied.reduceMotion));
          if (Array.isArray(spec.fonts)) {
            const merged = [...(state.importedFonts || [])];
            for (const f of spec.fonts) {
              if (!merged.find((x) => x.name.toLowerCase() === f.name.toLowerCase())) {
                merged.push({ id: f.id || `${f.name}-${Date.now()}`, name: f.name, href: f.href });
              }
            }
            window.localStorage.setItem('explorie:importedFonts', JSON.stringify(merged));
            (applied as Partial<UISlice>).importedFonts = merged;
          }
        }
      } catch {}
      return applied;
    });
  },
});
