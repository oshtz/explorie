import React from 'react';
import styles from './SettingsPanel.module.css';
import { useFileStore } from '../store';
import type { ThemeSpec } from '../store';
import { Icon } from './Icon';
import { UpdateStatus } from './UpdateStatus';
import { reportError } from '../utils/errorReporter';
import { invoke } from '@tauri-apps/api/core';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type SettingsTab = 'general' | 'appearance' | 'advanced' | 'themes' | 'plugins' | 'about';
type AccentPreset = Exclude<ThemeSpec['accent'], 'custom'>;

const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'themes', label: 'Themes' },
  { key: 'plugins', label: 'Plugins' },
  { key: 'about', label: 'About' },
];

const ACCENT_PRESETS: { key: AccentPreset; hex: string }[] = [
  { key: 'blue', hex: '#7cc7ff' },
  { key: 'green', hex: '#9ad1a8' },
  { key: 'purple', hex: '#b39ddb' },
  { key: 'orange', hex: '#ffb86b' },
  { key: 'pink', hex: '#ff8aa0' },
];

const FONT_CHOICES = ['system', 'mono', 'serif', 'custom'] as const;

function isFontChoice(value: string): value is ThemeSpec['font'] {
  return (FONT_CHOICES as readonly string[]).includes(value);
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const {
    theme,
    setTheme,
    accent,
    setAccent,
    accentCustom,
    setAccentCustom,
    density,
    setDensity,
    uiScale,
    setUiScale,
    font,
    setFont,
    fontCustom,
    setFontCustom,
    importedFonts,
    addImportedFont,
    removeImportedFont,
    borderRadius,
    setBorderRadius,
    iconSize,
    setIconSize,
    reduceMotion,
    setReduceMotion,
    listRowHeight,
    setListRowHeight,
    gridMinWidth,
    setGridMinWidth,
    showHidden,
    setShowHidden,
    showPreviewPanel,
    setShowPreviewPanel,
    showStatusBar,
    setShowStatusBar,
    showFolderSizes,
    setShowFolderSizes,
    enableDnDLargeLists,
    setEnableDnDLargeLists,
    previewExecutableScripts,
    setPreviewExecutableScripts,
    devMockEntries,
    setDevMockEntries,
    defaultExplorerSupported,
    defaultExplorerEnabled,
    defaultExplorerLoading,
    defaultExplorerError,
    refreshDefaultExplorer,
    makeDefaultExplorer,
    revertDefaultExplorer,
    clearDefaultExplorerError,
    confirmBeforeDelete,
    setConfirmBeforeDelete,
    enableErrorReporting,
    setEnableErrorReporting,
  } = useFileStore();

  const dialogRef = React.useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('appearance');
  const [status, setStatus] = React.useState<string>('');
  const [defaultStatus, setDefaultStatus] = React.useState<string>('');
  const [themeName, setThemeName] = React.useState<string>('');
  const [importText, setImportText] = React.useState<string>('');
  const themes = useFileStore((s) => s.themes);

  // Plugin management state
  const [plugins, setPlugins] = React.useState<string[]>([]);
  const [pluginMethods, setPluginMethods] = React.useState<Record<string, string[]>>({});
  const [selectedPlugin, setSelectedPlugin] = React.useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = React.useState<string | null>(null);
  const [pluginPayload, setPluginPayload] = React.useState<string>('');
  const [pluginResult, setPluginResult] = React.useState<string>('');
  const [pluginLoading, setPluginLoading] = React.useState(false);
  const [pluginsLoading, setPluginsLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Prevent background scroll, focus dialog, and trap focus
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = dialogRef.current;
    setTimeout(() => el?.focus(), 0);
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      setDefaultStatus('');
      clearDefaultExplorerError();
      return;
    }
    if (defaultExplorerSupported) {
      refreshDefaultExplorer().catch((err) =>
        reportError('Failed to check default explorer status', err, { warning: true })
      );
    }
  }, [open, defaultExplorerSupported, refreshDefaultExplorer, clearDefaultExplorerError]);

  // Load plugins when the plugins tab is selected
  React.useEffect(() => {
    if (!open || activeTab !== 'plugins') return;

    const loadPlugins = async () => {
      setPluginsLoading(true);
      try {
        const pluginList = await invoke<string[]>('list_plugins');
        setPlugins(pluginList);

        // Load methods for each plugin
        const methodsMap: Record<string, string[]> = {};
        for (const plugin of pluginList) {
          try {
            const methods = await invoke<string[]>('get_plugin_methods', { plugin });
            methodsMap[plugin] = methods;
          } catch {
            methodsMap[plugin] = [];
          }
        }
        setPluginMethods(methodsMap);

        // Select first plugin if available
        setSelectedPlugin((currentPlugin) => {
          if (currentPlugin || pluginList.length === 0) return currentPlugin;
          const firstPlugin = pluginList[0];
          const methods = methodsMap[firstPlugin] || [];
          if (methods.length > 0) {
            setSelectedMethod(methods[0]);
          }
          return firstPlugin;
        });
      } catch (err) {
        reportError('Failed to load plugins', err);
      } finally {
        setPluginsLoading(false);
      }
    };

    loadPlugins();
  }, [open, activeTab]);

  const invokePlugin = async () => {
    if (!selectedPlugin || !selectedMethod) return;

    setPluginLoading(true);
    setPluginResult('');

    try {
      let payload = null;
      if (pluginPayload.trim()) {
        try {
          payload = JSON.parse(pluginPayload);
        } catch {
          setPluginResult('Error: Invalid JSON payload');
          setPluginLoading(false);
          return;
        }
      }

      const result = await invoke('call_plugin', {
        plugin: selectedPlugin,
        method: selectedMethod,
        payload,
      });
      setPluginResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setPluginResult(`Error: ${err}`);
    } finally {
      setPluginLoading(false);
    }
  };

  const onKeyDownTrap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const panel = dialogRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        last.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  };

  const resetToDefaults = () => {
    setTheme('dark');
    setFont('mono');
    setBorderRadius(0);
    setIconSize(14);
    setShowHidden(false);
    setShowFolderSizes(false);
    setShowPreviewPanel(false);
    setEnableDnDLargeLists(false);
    setPreviewExecutableScripts(false);
    setDevMockEntries(false);
    setAccent('blue');
    setAccentCustom('#7cc7ff');
    setDensity('comfortable');
    setUiScale(1.0);
    setReduceMotion(false);
  };

  const handleMakeDefaultExplorer = async () => {
    clearDefaultExplorerError();
    setDefaultStatus('');
    try {
      await makeDefaultExplorer();
      setDefaultStatus('explorie is now the default file manager.');
    } catch (err) {
      reportError('Failed to set as default explorer', err);
    }
  };

  const handleRevertDefaultExplorer = async () => {
    clearDefaultExplorerError();
    setDefaultStatus('');
    try {
      await revertDefaultExplorer();
      setDefaultStatus('Windows Explorer restored as default.');
    } catch (err) {
      reportError('Failed to restore Windows Explorer as default', err);
    }
  };

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        // Close when clicking outside the panel
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDownTrap}
      >
        <div className={styles.header}>
          <div className={styles.title} id="settings-title">
            Settings
          </div>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close settings">
            <Icon name="close" />
          </button>
        </div>
        <div className={styles.content}>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Settings Tabs"
            aria-orientation="vertical"
          >
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                className={`${styles.tab} ${activeTab === t.key ? styles.tabActive : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === 'general' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>General</div>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={showPreviewPanel}
                  onChange={(e) => setShowPreviewPanel(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>Right preview panel</span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => setShowHidden(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>Show hidden files</span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={showStatusBar}
                  onChange={(e) => setShowStatusBar(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>Show status bar</span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={showFolderSizes}
                  onChange={(e) => setShowFolderSizes(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>Show folder sizes</span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={confirmBeforeDelete}
                  onChange={(e) => setConfirmBeforeDelete(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>
                  Confirm before delete
                  <span className={styles.rowHint}>Show detailed dialog before deleting files</span>
                </span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={enableErrorReporting}
                  onChange={(e) => setEnableErrorReporting(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>
                  Error reporting
                  <span className={styles.rowHint}>
                    Collect anonymous error data to help improve explorie
                  </span>
                </span>
              </label>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Appearance</div>
              {/* Theme selection */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Theme</div>
                <div className={styles.controls}>
                  <button
                    onClick={() => setTheme('dark')}
                    aria-pressed={theme === 'dark'}
                    title="Dark"
                  >
                    <Icon name="moon" /> Dark
                  </button>
                  <button
                    onClick={() => setTheme('light')}
                    aria-pressed={theme === 'light'}
                    title="Light"
                  >
                    <Icon name="sun" /> Light
                  </button>
                  <button
                    onClick={() => setTheme('system')}
                    aria-pressed={theme === 'system'}
                    title="System"
                  >
                    <Icon name="monitor" /> System
                  </button>
                </div>
              </div>

              {/* Accent color */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Accent</div>
                <div className={styles.controls}>
                  <div className={styles.swatches}>
                    {ACCENT_PRESETS.map((c) => (
                      <button
                        key={c.key}
                        onClick={() => setAccent(c.key)}
                        aria-pressed={accent === c.key}
                        aria-label={String(c.key)}
                        title={String(c.key)}
                        className={`${styles.swatch} ${accent === c.key ? styles.swatchActive : ''}`}
                        style={{ background: c.hex }}
                      />
                    ))}
                  </div>
                  <label className={styles.inlineFlex}>
                    <span>Custom</span>
                    <input
                      type="color"
                      value={accentCustom}
                      onChange={(e) => setAccentCustom(e.target.value)}
                      title="Pick custom accent"
                    />
                  </label>
                </div>
              </div>

              {/* Density */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Density</div>
                <div className={styles.controls}>
                  <button
                    onClick={() => setDensity('comfortable')}
                    aria-pressed={density === 'comfortable'}
                  >
                    Comfortable
                  </button>
                  <button
                    onClick={() => setDensity('compact')}
                    aria-pressed={density === 'compact'}
                  >
                    Compact
                  </button>
                </div>
              </div>

              {/* UI Scale */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>UI Scale</div>
                <div className={styles.controls}>
                  <input
                    type="range"
                    min={0.9}
                    max={1.2}
                    step={0.01}
                    value={uiScale}
                    onChange={(e) => setUiScale(parseFloat(e.target.value))}
                  />
                  <span className={styles.measurementValue}>{uiScale.toFixed(2)}x</span>
                </div>
              </div>

              {/* List row height */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>List row height</div>
                <div className={styles.controls}>
                  <input
                    type="range"
                    min={26}
                    max={52}
                    step={1}
                    value={listRowHeight}
                    onChange={(e) => setListRowHeight(parseInt(e.target.value))}
                  />
                  <span className={styles.measurementValue}>{listRowHeight}px</span>
                </div>
              </div>

              {/* Grid card width */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Grid card width</div>
                <div className={styles.controls}>
                  <input
                    type="range"
                    min={120}
                    max={260}
                    step={2}
                    value={gridMinWidth}
                    onChange={(e) => setGridMinWidth(parseInt(e.target.value))}
                  />
                  <span className={styles.measurementValue}>{gridMinWidth}px</span>
                </div>
              </div>

              {/* Font selection */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Font</div>
                <div className={styles.controls}>
                  <select
                    value={(() => {
                      if (font === 'custom') {
                        const hit = (importedFonts || []).find(
                          (f) => f.name.toLowerCase() === (fontCustom || '').toLowerCase()
                        );
                        return hit ? `import:${hit.id}` : 'custom';
                      }
                      return font;
                    })()}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('import:')) {
                        const id = v.slice('import:'.length);
                        const f = (importedFonts || []).find((x) => x.id === id);
                        if (f) {
                          setFont('custom');
                          setFontCustom(f.name);
                        }
                        return;
                      }
                      if (isFontChoice(v)) {
                        setFont(v);
                      }
                    }}
                  >
                    <option value="system">System (Sans)</option>
                    <option value="mono">System Mono</option>
                    <option value="serif">Serif</option>
                    {(importedFonts || []).length > 0 && <option disabled>────────</option>}
                    {(importedFonts || []).map((f) => (
                      <option key={f.id} value={`import:${f.id}`}>
                        Imported: {f.name}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </select>
                  {font === 'custom' &&
                    (!importedFonts ||
                      !(importedFonts || []).some(
                        (f) => f.name.toLowerCase() === (fontCustom || '').toLowerCase()
                      )) && (
                      <input
                        type="text"
                        placeholder="CSS font-family, e.g. 'Fira Code', monospace"
                        className={styles.inputMedium}
                        value={fontCustom}
                        onChange={(e) => setFontCustom(e.target.value)}
                      />
                    )}
                </div>
              </div>

              {/* Import Google Font */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Import font</div>
                <div className={styles.controls}>
                  <input
                    id="gf-url"
                    type="text"
                    placeholder="Google Fonts CSS URL (optional)"
                    className={styles.inputWide}
                  />
                  <input
                    id="gf-name"
                    type="text"
                    placeholder="Family name (e.g., Inter)"
                    className={styles.inputNarrow}
                  />
                  <button
                    onClick={() => {
                      const urlInput = (
                        document.getElementById('gf-url') as HTMLInputElement
                      )?.value.trim();
                      let name = (
                        document.getElementById('gf-name') as HTMLInputElement
                      )?.value.trim();
                      let url = urlInput;

                      function buildUrl(family: string) {
                        const fam = family.trim().replace(/\s+/g, '+');
                        return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@400;700&display=swap`;
                      }
                      function parseNameFromUrl(u: string): string | null {
                        try {
                          const parsed = new URL(u);
                          const fam = parsed.searchParams.getAll('family')[0];
                          if (!fam) return null;
                          return fam.split(':')[0].replace(/\+/g, ' ');
                        } catch {
                          return null;
                        }
                      }

                      // If only name is provided, generate URL
                      if (!url && name) url = buildUrl(name);
                      // If only URL is provided, try to extract name
                      if (url && !name) name = parseNameFromUrl(url) || '';

                      if (!name && !url) {
                        setStatus('Enter a font name or provide a Google Fonts CSS URL');
                        return;
                      }
                      if (!url) {
                        setStatus('Could not generate URL for that name');
                        return;
                      }
                      if (!name) {
                        setStatus('Could not infer family name from the URL');
                        return;
                      }

                      const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
                      addImportedFont({ id, name, href: url });
                      setFont('custom');
                      setFontCustom(name);
                      setStatus(`Imported font: ${name}`);
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Manage imported fonts */}
              {(importedFonts || []).length > 0 && (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Manage fonts</div>
                  <div className={`${styles.controls} ${styles.flexWrap}`}>
                    {(importedFonts || []).map((f) => (
                      <span key={f.id} className={styles.tagBadge}>
                        <strong>{f.name}</strong>
                        <button
                          onClick={() => {
                            setFont('custom');
                            setFontCustom(f.name);
                          }}
                        >
                          Use
                        </button>
                        <button onClick={() => removeImportedFont(f.id)}>Remove</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Corners */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Corners</div>
                <div className={styles.controls}>
                  <button onClick={() => setBorderRadius(0)} aria-pressed={borderRadius === 0}>
                    Square
                  </button>
                  <button onClick={() => setBorderRadius(4)} aria-pressed={borderRadius === 4}>
                    Slight
                  </button>
                  <button onClick={() => setBorderRadius(8)} aria-pressed={borderRadius === 8}>
                    Rounded
                  </button>
                </div>
              </div>

              {/* Icon size */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Icon size</div>
                <div className={styles.controls}>
                  <input
                    type="range"
                    min={12}
                    max={20}
                    step={1}
                    value={iconSize}
                    onChange={(e) => setIconSize(parseInt(e.target.value))}
                  />
                  <span className={styles.measurementValueSmall}>{iconSize}px</span>
                </div>
              </div>

              {/* Reduce motion */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Reduce motion</div>
                <div className={styles.controls}>
                  <input
                    type="checkbox"
                    checked={reduceMotion}
                    onChange={(e) => setReduceMotion(e.target.checked)}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'themes' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Theme Presets</div>
              {/* Save current theme */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Save as</div>
                <div className={styles.controls}>
                  <input
                    type="text"
                    placeholder="Theme name"
                    value={themeName}
                    onChange={(e) => setThemeName(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      const nm = themeName.trim();
                      if (nm.toLowerCase() === 'default') {
                        setStatus('Name "Default" is reserved');
                        return;
                      }
                      const name = nm || `Theme ${new Date().toLocaleString()}`;
                      useFileStore.getState().saveTheme(name);
                      setStatus(`Saved theme: ${name}`);
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>

              {/* List saved themes (Default + user themes) */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Saved</div>
                <div className={`${styles.controls} ${styles.flexWrap}`}>
                  <span className={styles.tagBadge}>
                    <strong>Default</strong>
                    <button
                      onClick={() => {
                        const def: ThemeSpec = {
                          theme: 'dark',
                          accent: 'blue',
                          accentCustom: '#7cc7ff',
                          density: 'comfortable',
                          uiScale: 1.0,
                          listRowHeight: 34,
                          gridMinWidth: 140,
                          font: 'mono',
                          fontCustom: '',
                          borderRadius: 0,
                          iconSize: 14,
                          reduceMotion: false,
                        };
                        useFileStore.getState().applyThemeSpec(def);
                        setStatus('Applied default theme');
                      }}
                    >
                      Apply
                    </button>
                  </span>
                  {Object.entries(themes || {}).map(([name, spec]) => (
                    <span key={name} className={styles.tagBadge}>
                      <strong>{name}</strong>
                      <button
                        onClick={() => {
                          useFileStore.getState().applyThemeSpec(spec as ThemeSpec);
                          setStatus(`Applied theme: ${name}`);
                        }}
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => {
                          if (name.toLowerCase() === 'default') {
                            setStatus('Default theme is built-in');
                            return;
                          }
                          useFileStore.getState().saveTheme(name);
                          setStatus(`Updated theme: ${name}`);
                        }}
                      >
                        Update
                      </button>
                      <button
                        onClick={() => {
                          if (name.toLowerCase() === 'default') {
                            setStatus('Default theme cannot be deleted');
                            return;
                          }
                          useFileStore.getState().deleteTheme(name);
                          setStatus(`Deleted theme: ${name}`);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  ))}
                  {Object.entries(themes || {}).length === 0 && (
                    <span className={styles.textMuted}>No custom themes yet</span>
                  )}
                </div>
              </div>

              {/* Export / Import */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Export</div>
                <div className={styles.controls}>
                  <button
                    onClick={async () => {
                      const s: ThemeSpec = {
                        theme,
                        accent,
                        accentCustom,
                        density,
                        uiScale,
                        listRowHeight,
                        gridMinWidth,
                        font,
                        fontCustom,
                        borderRadius,
                        iconSize,
                        reduceMotion,
                        fonts: importedFonts,
                      };
                      const txt = JSON.stringify(s, null, 2);
                      try {
                        await navigator.clipboard.writeText(txt);
                        setStatus('Copied current theme JSON');
                      } catch {
                        const ta = document.createElement('textarea');
                        ta.value = txt;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        setStatus('Copied current theme JSON');
                      }
                    }}
                  >
                    Copy Current
                  </button>
                  <button
                    onClick={async () => {
                      const all = useFileStore.getState().themes || {};
                      const txt = JSON.stringify(all, null, 2);
                      try {
                        await navigator.clipboard.writeText(txt);
                        setStatus('Copied all themes JSON');
                      } catch {
                        const ta = document.createElement('textarea');
                        ta.value = txt;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        setStatus('Copied all themes JSON');
                      }
                    }}
                  >
                    Copy All
                  </button>
                </div>
              </div>

              <div className={styles.row}>
                <div className={styles.rowLabel}>Import</div>
                <div className={`${styles.controls} ${styles.flex1}`}>
                  <textarea
                    placeholder="Paste JSON for a theme spec or a map of themes"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className={styles.importTextarea}
                  />
                  <button
                    onClick={() => {
                      try {
                        const obj = JSON.parse(importText);
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                          if ('theme' in obj || 'accent' in obj) {
                            // single spec
                            const name =
                              themeName.trim() || `Imported ${new Date().toLocaleString()}`;
                            const spec = obj as ThemeSpec;
                            useFileStore.getState().saveTheme(name, spec);
                            // Merge fonts immediately into imported list
                            if (Array.isArray(spec.fonts)) {
                              for (const f of spec.fonts)
                                addImportedFont({
                                  id: f.id || `${f.name}-${Date.now()}`,
                                  name: f.name,
                                  href: f.href,
                                });
                            }
                            setStatus(`Imported as: ${name}`);
                          } else {
                            // map
                            const entries = Object.entries(obj as Record<string, ThemeSpec>);
                            let count = 0;
                            for (const [n, s] of entries) {
                              useFileStore.getState().saveTheme(n, s);
                              count++;
                              if (Array.isArray(s.fonts)) {
                                for (const f of s.fonts)
                                  addImportedFont({
                                    id: f.id || `${f.name}-${Date.now()}`,
                                    name: f.name,
                                    href: f.href,
                                  });
                              }
                            }
                            setStatus(`Imported ${count} themes`);
                          }
                        } else {
                          setStatus('Invalid JSON');
                        }
                      } catch {
                        setStatus('Failed to import JSON');
                      }
                    }}
                  >
                    Import
                  </button>
                </div>
              </div>

              {status && (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Status</div>
                  <div className={styles.controls}>
                    <span className={styles.textSecondary}>{status}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Advanced</div>
              <div className={styles.row}>
                <div
                  className={styles.rowLabel}
                  title="Allow drag & drop even on large lists (may be slower)"
                >
                  DnD on large lists
                </div>
                <div className={styles.controls}>
                  <input
                    id="dnd-large-lists"
                    type="checkbox"
                    checked={enableDnDLargeLists}
                    onChange={(e) => setEnableDnDLargeLists(e.target.checked)}
                  />
                </div>
              </div>
              <div className={styles.row}>
                <div
                  className={styles.rowLabel}
                  title="Display the raw contents of PowerShell or batch scripts in the preview panel."
                >
                  Preview executable scripts
                </div>
                <div className={styles.controls}>
                  <input
                    id="preview-executable-scripts"
                    type="checkbox"
                    checked={previewExecutableScripts}
                    onChange={(e) => setPreviewExecutableScripts(e.target.checked)}
                  />
                </div>
              </div>
              <div className={styles.row}>
                <div
                  className={styles.rowLabel}
                  title="Development helper: populate mock entries in views (local only)"
                >
                  Dev: mock entries
                </div>
                <div className={styles.controls}>
                  <input
                    id="dev-mock-entries"
                    type="checkbox"
                    checked={devMockEntries}
                    onChange={(e) => setDevMockEntries(e.target.checked)}
                  />
                </div>
              </div>
              {defaultExplorerSupported ? (
                <>
                  <div className={styles.row}>
                    <div className={styles.rowLabel}>Default explorer</div>
                    <div className={`${styles.controls} ${styles.actionsRow}`}>
                      <button
                        type="button"
                        onClick={handleMakeDefaultExplorer}
                        disabled={
                          defaultExplorerLoading ||
                          defaultExplorerEnabled === true ||
                          defaultExplorerEnabled === null
                        }
                      >
                        {defaultExplorerLoading && defaultExplorerEnabled === false
                          ? 'Setting…'
                          : 'Make explorie default'}
                      </button>
                      <button
                        type="button"
                        onClick={handleRevertDefaultExplorer}
                        disabled={
                          defaultExplorerLoading ||
                          defaultExplorerEnabled === false ||
                          defaultExplorerEnabled === null
                        }
                      >
                        {defaultExplorerLoading && defaultExplorerEnabled === true
                          ? 'Reverting…'
                          : 'Revert to Windows Explorer'}
                      </button>
                    </div>
                  </div>
                  <div className={styles.row}>
                    <div className={styles.rowLabel} aria-hidden="true" />
                    <div className={`${styles.controls} ${styles.statusControls}`}>
                      <span className={styles.statusText}>
                        {defaultExplorerLoading
                          ? defaultExplorerEnabled === false
                            ? 'Setting explorie as the default explorer…'
                            : 'Restoring Windows Explorer…'
                          : typeof defaultExplorerEnabled === 'boolean'
                            ? defaultExplorerEnabled
                              ? 'explorie is currently the default explorer.'
                              : 'Windows Explorer is currently the default explorer.'
                            : 'Checking default explorer status…'}
                      </span>
                      {defaultStatus && (
                        <span className={styles.statusTextSuccess}>{defaultStatus}</span>
                      )}
                      {defaultExplorerError && (
                        <span className={styles.statusTextError}>{defaultExplorerError}</span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Default explorer</div>
                  <div className={`${styles.controls} ${styles.statusControls}`}>
                    <span className={styles.statusText}>Only available on Windows builds.</span>
                  </div>
                </div>
              )}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Reset all settings</div>
                <div className={`${styles.controls} ${styles.actionsRow}`}>
                  <button onClick={resetToDefaults} title="Restore defaults">
                    Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'plugins' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Plugins</div>
              {pluginsLoading ? (
                <div className={styles.row}>
                  <span className={styles.textMuted}>Loading plugins...</span>
                </div>
              ) : plugins.length === 0 ? (
                <div className={styles.row}>
                  <span className={styles.textMuted}>No plugins registered</span>
                </div>
              ) : (
                <>
                  {/* Plugin selector */}
                  <div className={styles.row}>
                    <div className={styles.rowLabel}>Plugin</div>
                    <div className={styles.controls}>
                      <select
                        value={selectedPlugin || ''}
                        onChange={(e) => {
                          const plugin = e.target.value;
                          setSelectedPlugin(plugin);
                          setPluginResult('');
                          const methods = pluginMethods[plugin] || [];
                          setSelectedMethod(methods.length > 0 ? methods[0] : null);
                        }}
                      >
                        {plugins.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Method selector */}
                  {selectedPlugin && (
                    <div className={styles.row}>
                      <div className={styles.rowLabel}>Method</div>
                      <div className={styles.controls}>
                        {(pluginMethods[selectedPlugin] || []).length === 0 ? (
                          <span className={styles.textMuted}>No methods exposed</span>
                        ) : (
                          <select
                            value={selectedMethod || ''}
                            onChange={(e) => {
                              setSelectedMethod(e.target.value);
                              setPluginResult('');
                            }}
                          >
                            {(pluginMethods[selectedPlugin] || []).map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Payload input */}
                  {selectedMethod && (
                    <div className={styles.row}>
                      <div className={styles.rowLabel}>Payload (JSON)</div>
                      <div className={`${styles.controls} ${styles.flex1}`}>
                        <textarea
                          placeholder='{"key": "value"}'
                          value={pluginPayload}
                          onChange={(e) => setPluginPayload(e.target.value)}
                          className={styles.pluginPayload}
                        />
                      </div>
                    </div>
                  )}

                  {/* Invoke button */}
                  {selectedMethod && (
                    <div className={styles.row}>
                      <div className={styles.rowLabel} />
                      <div className={styles.controls}>
                        <button
                          onClick={invokePlugin}
                          disabled={pluginLoading || !selectedPlugin || !selectedMethod}
                        >
                          {pluginLoading ? 'Invoking...' : 'Invoke'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Result display */}
                  {pluginResult && (
                    <div className={styles.row}>
                      <div className={styles.rowLabel}>Result</div>
                      <div className={`${styles.controls} ${styles.flex1}`}>
                        <pre className={styles.pluginResult}>{pluginResult}</pre>
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className={styles.row}>
                <div className={styles.rowLabel} />
                <div className={styles.controls}>
                  <span className={styles.textMuted}>
                    Plugins extend explorie with custom functionality.
                  </span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <>
              <div className={styles.section}>
                <div className={styles.sectionTitle}>Updates</div>
                <UpdateStatus />
              </div>
              <div className={styles.section}>
                <div className={styles.sectionTitle}>About</div>
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Version</div>
                  <div className={styles.controls}>
                    <code>
                      {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'}
                    </code>
                  </div>
                </div>
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Environment</div>
                  <div className={styles.controls}>
                    <code>{import.meta.env.MODE}</code>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className={styles.footer}>
          <div>These settings persist locally.</div>
          <div>
            <span className={styles.textDimmed}>Press Esc to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
