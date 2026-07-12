import type { StateCreator } from 'zustand';
import type {
  StoreState,
  UISlice,
  ThemeSpec,
  ThemeMode,
  AccentColor,
  Density,
  FontChoice,
  BorderRadius,
} from '../types';
import type { ViewMode } from '../../components/ViewModeToggle';
import { loadRemoteDrives } from '../../utils/remoteDrives';

const THEME_MODES = ['dark', 'light', 'system'] as const;
const ACCENT_COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'custom'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;
const FONT_CHOICES = ['mono', 'system', 'serif', 'custom'] as const;
const BORDER_RADII = [0, 4, 8] as const;

export function loadRemoteDrivesEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const value = window.localStorage.getItem('explorie:remoteDrivesEnabled');
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
  } catch {}
  return loadRemoteDrives().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : null;
}

export function normalizeThemeSpec(value: unknown): ThemeSpec | null {
  if (!isRecord(value)) return null;

  const uiScale = clampNumber(value.uiScale, 0.9, 1.4);
  const listRowHeight = clampNumber(value.listRowHeight, 26, 52);
  const gridMinWidth = clampNumber(value.gridMinWidth, 120, 260);
  const iconSize = clampNumber(value.iconSize, 10, 24);

  if (
    !isOneOf(THEME_MODES, value.theme) ||
    !isOneOf(ACCENT_COLORS, value.accent) ||
    typeof value.accentCustom !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(value.accentCustom) ||
    !isOneOf(DENSITIES, value.density) ||
    uiScale === null ||
    listRowHeight === null ||
    gridMinWidth === null ||
    !isOneOf(FONT_CHOICES, value.font) ||
    (value.fontCustom !== undefined && typeof value.fontCustom !== 'string') ||
    !isOneOf(BORDER_RADII, value.borderRadius) ||
    iconSize === null ||
    typeof value.reduceMotion !== 'boolean'
  ) {
    return null;
  }

  return {
    theme: value.theme,
    accent: value.accent,
    accentCustom: value.accentCustom,
    density: value.density,
    uiScale,
    listRowHeight: Math.round(listRowHeight),
    gridMinWidth: Math.round(gridMinWidth),
    font: value.font,
    fontCustom: value.fontCustom ?? '',
    borderRadius: value.borderRadius,
    iconSize: Math.round(iconSize),
    reduceMotion: value.reduceMotion,
  };
}

function normalizeThemeMap(value: unknown): Record<string, ThemeSpec> | null {
  if (!isRecord(value)) return null;
  const normalized: Record<string, ThemeSpec> = {};
  for (const [name, spec] of Object.entries(value)) {
    const cleanName = name.trim();
    const cleanSpec = normalizeThemeSpec(spec);
    if (!cleanName || cleanName.toLowerCase() === 'default' || !cleanSpec) return null;
    normalized[cleanName] = cleanSpec;
  }
  return normalized;
}

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
        if (Number.isFinite(v) && v >= 0.9 && v <= 1.4) return v;
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
  remoteDrivesEnabled: loadRemoteDrivesEnabled(),
  themes: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:themes');
        if (raw) return normalizeThemeMap(JSON.parse(raw)) ?? {};
      }
    } catch {}
    return {};
  })(),
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
    const s = Math.min(1.4, Math.max(0.9, v));
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
  setRemoteDrivesEnabled: (enabled) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:remoteDrivesEnabled', String(enabled));
      }
    } catch {}
    set({ remoteDrivesEnabled: enabled });
  },
  saveTheme: (name: string, spec?: ThemeSpec) => {
    set((state) => {
      const candidate: ThemeSpec = spec || {
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
      };
      const s = normalizeThemeSpec(candidate);
      if (!s) return {};
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
    set(() => {
      const normalized = normalizeThemeSpec(spec);
      if (!normalized) return {};
      const applied: Partial<StoreState> = {
        theme: normalized.theme,
        accent: normalized.accent,
        accentCustom: normalized.accentCustom,
        density: normalized.density,
        uiScale: normalized.uiScale,
        listRowHeight: normalized.listRowHeight,
        gridMinWidth: normalized.gridMinWidth,
        font: normalized.font,
        fontCustom: normalized.fontCustom,
        borderRadius: normalized.borderRadius,
        iconSize: normalized.iconSize,
        reduceMotion: normalized.reduceMotion,
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
        }
      } catch {}
      return applied;
    });
  },
});
