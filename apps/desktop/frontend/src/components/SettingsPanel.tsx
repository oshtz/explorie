import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './SettingsPanel.module.css';
import { useFileStore } from '../store';
import type { ThemeSpec } from '../store';
import { normalizeThemeSpec } from '../store/slices/uiSlice';
import { createFocusTrap } from '../utils/accessibility';
import { Icon } from './Icon';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type SettingsTab = 'general' | 'integration' | 'appearance' | 'themes' | 'about';
type AccentPreset = Exclude<ThemeSpec['accent'], 'custom'>;

type SystemIntegrationStatus = {
  supported: boolean;
  enabled: boolean;
};

const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'integration', label: 'System Integration' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'themes', label: 'Themes' },
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
    borderRadius,
    setBorderRadius,
    iconSize,
    setIconSize,
    reduceMotion,
    setReduceMotion,
    highContrast,
    setHighContrast,
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
    remoteDrivesEnabled,
    setRemoteDrivesEnabled,
    showFolderSizes,
    setShowFolderSizes,
    previewExecutableScripts,
    setPreviewExecutableScripts,
    confirmBeforeDelete,
    setConfirmBeforeDelete,
    enableErrorReporting,
    setEnableErrorReporting,
  } = useFileStore();

  const dialogRef = React.useRef<HTMLDivElement>(null);
  const focusTrapRef = React.useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('general');
  const [status, setStatus] = React.useState<string>('');
  const [themeName, setThemeName] = React.useState<string>('');
  const [importText, setImportText] = React.useState<string>('');
  const [systemIntegration, setSystemIntegration] = React.useState<SystemIntegrationStatus | null>(
    null
  );
  const [systemIntegrationBusy, setSystemIntegrationBusy] = React.useState(false);
  const themes = useFileStore((s) => s.themes);

  React.useEffect(() => {
    if (!open) return;
    setActiveTab('general');
    setStatus('');
    setSystemIntegration(null);
    void invoke<SystemIntegrationStatus>('get_system_integration_status')
      .then(setSystemIntegration)
      .catch(() => setSystemIntegration({ supported: false, enabled: false }));
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Prevent background scroll and keep keyboard focus in the dialog.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    const el = dialogRef.current;
    if (!el) return;
    document.body.style.overflow = 'hidden';
    const trap = createFocusTrap(el);
    focusTrapRef.current = trap;
    const frame = requestAnimationFrame(() => trap.activate());
    return () => {
      cancelAnimationFrame(frame);
      focusTrapRef.current = null;
      trap.deactivate();
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onKeyDownTrap = (e: React.KeyboardEvent) => {
    focusTrapRef.current?.handleKeyDown(e);
  };

  const updateSystemIntegration = async (enabled: boolean) => {
    setSystemIntegrationBusy(true);
    setStatus('');
    try {
      const next = await invoke<SystemIntegrationStatus>('set_system_integration', { enabled });
      setSystemIntegration(next);
      setStatus(enabled ? 'Windows integration enabled' : 'Windows integration removed');
    } catch (error) {
      setStatus(`Could not update Windows integration: ${String(error)}`);
    } finally {
      setSystemIntegrationBusy(false);
    }
  };

  const resetToDefaults = () => {
    setTheme('dark');
    setFont('mono');
    setFontCustom('');
    setBorderRadius(0);
    setIconSize(14);
    setShowHidden(false);
    setShowFolderSizes(false);
    setShowPreviewPanel(false);
    setShowStatusBar(true);
    setRemoteDrivesEnabled(false);
    setPreviewExecutableScripts(false);
    setConfirmBeforeDelete(true);
    setEnableErrorReporting(false);
    setAccent('blue');
    setAccentCustom('#7cc7ff');
    setDensity('comfortable');
    setUiScale(1.0);
    setListRowHeight(34);
    setGridMinWidth(140);
    setReduceMotion(false);
    setHighContrast(false);
    setStatus('Settings restored to defaults');
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
          <nav className={styles.tabs} aria-label="Settings sections">
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-current={activeTab === t.key ? 'page' : undefined}
                className={`${styles.tab} ${activeTab === t.key ? styles.tabActive : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {activeTab === 'general' && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>General</h2>
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
                  checked={remoteDrivesEnabled}
                  onChange={(e) => setRemoteDrivesEnabled(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>
                  Enable Remote Drives
                  <span className={styles.rowHint}>
                    Show and auto-connect configured rclone remotes; existing mounts remain until
                    restart
                  </span>
                </span>
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
                    Keep diagnostics in memory for local export; nothing is sent
                  </span>
                </span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={previewExecutableScripts}
                  onChange={(e) => setPreviewExecutableScripts(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>
                  Preview executable scripts
                  <span className={styles.rowHint}>
                    Display raw PowerShell and batch script contents
                  </span>
                </span>
              </label>
            </div>
          )}

          {activeTab === 'integration' && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>System Integration</h2>
              {systemIntegration === null ? (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Windows</div>
                  <div className={styles.controls}>Checking integration…</div>
                </div>
              ) : systemIntegration.supported ? (
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={systemIntegration.enabled}
                    disabled={systemIntegrationBusy}
                    onChange={(event) => void updateSystemIntegration(event.target.checked)}
                  />
                  <span className={styles.checkboxRowLabel}>
                    Open folders with Explorie
                    <span className={styles.rowHint}>
                      Adds “Open in Explorie” to folder, drive, and folder-background menus. Windows
                      Explorer remains available.
                    </span>
                  </span>
                </label>
              ) : (
                <div className={styles.row}>
                  <div className={styles.rowLabel}>Unavailable</div>
                  <div className={styles.controls}>
                    System integration is currently available only on Windows.
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Appearance</h2>
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
                    aria-label="UI scale"
                    min={0.9}
                    max={1.4}
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
                    aria-label="List row height"
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
                    aria-label="Grid card width"
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
                    aria-label="Font"
                    value={font}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isFontChoice(v)) {
                        setFont(v);
                      }
                    }}
                  >
                    <option value="system">System (Sans)</option>
                    <option value="mono">System Mono</option>
                    <option value="serif">Serif</option>
                    <option value="custom">Custom…</option>
                  </select>
                  {font === 'custom' && (
                    <input
                      type="text"
                      aria-label="Custom font family"
                      placeholder="CSS font-family, e.g. 'Fira Code', monospace"
                      className={styles.inputMedium}
                      value={fontCustom}
                      onChange={(e) => setFontCustom(e.target.value)}
                    />
                  )}
                </div>
              </div>

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
                    aria-label="Icon size"
                    min={12}
                    max={20}
                    step={1}
                    value={iconSize}
                    onChange={(e) => setIconSize(parseInt(e.target.value))}
                  />
                  <span className={styles.measurementValueSmall}>{iconSize}px</span>
                </div>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={reduceMotion}
                  onChange={(e) => setReduceMotion(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>Reduce motion</span>
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={highContrast}
                  onChange={(e) => setHighContrast(e.target.checked)}
                />
                <span className={styles.checkboxRowLabel}>High contrast</span>
              </label>
            </div>
          )}

          {activeTab === 'themes' && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Theme presets</h2>
              {/* Save current theme */}
              <div className={styles.row}>
                <div className={styles.rowLabel}>Save as</div>
                <div className={styles.controls}>
                  <input
                    type="text"
                    aria-label="Theme name"
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
                      aria-label="Apply default theme"
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
                        aria-label={`Apply ${name} theme`}
                        onClick={() => {
                          useFileStore.getState().applyThemeSpec(spec as ThemeSpec);
                          setStatus(`Applied theme: ${name}`);
                        }}
                      >
                        Apply
                      </button>
                      <button
                        aria-label={`Update ${name} theme`}
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
                        aria-label={`Delete ${name} theme`}
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
                    aria-label="Theme JSON"
                    placeholder="Paste JSON for a theme spec or a map of themes"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className={styles.importTextarea}
                  />
                  <button
                    onClick={() => {
                      try {
                        const obj = JSON.parse(importText);
                        const singleSpec = normalizeThemeSpec(obj);
                        if (singleSpec) {
                          const name =
                            themeName.trim() || `Imported ${new Date().toLocaleString()}`;
                          if (name.toLowerCase() === 'default') {
                            setStatus('Name "Default" is reserved');
                            return;
                          }
                          useFileStore.getState().saveTheme(name, singleSpec);
                          setStatus(`Imported as: ${name}`);
                          return;
                        }

                        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                          setStatus('Theme JSON must be a theme or map of themes');
                          return;
                        }
                        const entries = Object.entries(obj as Record<string, unknown>);
                        const normalized = entries.map(([name, spec]) => [
                          name.trim(),
                          normalizeThemeSpec(spec),
                        ]) as [string, ThemeSpec | null][];
                        if (
                          normalized.length === 0 ||
                          normalized.some(
                            ([name, spec]) =>
                              !name || name.toLowerCase() === 'default' || spec === null
                          )
                        ) {
                          setStatus('Theme map contains an invalid name or theme');
                          return;
                        }
                        for (const [name, spec] of normalized) {
                          useFileStore.getState().saveTheme(name, spec!);
                        }
                        setStatus(`Imported ${normalized.length} themes`);
                      } catch {
                        setStatus('Theme JSON is not valid JSON');
                      }
                    }}
                  >
                    Import
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>About</h2>
              <div className={styles.row}>
                <div className={styles.rowLabel}>Version</div>
                <div className={styles.controls}>
                  <code>{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'}</code>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className={styles.footer}>
          <div className={styles.footerStatus} role="status" aria-live="polite">
            {status || 'Changes apply immediately.'}
          </div>
          <div className={styles.footerActions}>
            <button type="button" onClick={resetToDefaults}>
              Reset to defaults
            </button>
            <span className={styles.textDimmed}>Esc</span>
            <button type="button" className={styles.footerCloseButton} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
