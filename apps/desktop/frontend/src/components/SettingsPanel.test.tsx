import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

type MockState = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const data = {
    invoke: vi.fn(),
    reportError: vi.fn(),
    state: {} as MockState,
    useFileStore: undefined as unknown as ((
      selector?: (state: MockState) => unknown
    ) => unknown) & {
      getState: () => MockState;
    },
  };

  data.useFileStore = Object.assign(
    (selector?: (state: MockState) => unknown) => (selector ? selector(data.state) : data.state),
    { getState: () => data.state }
  );

  return data;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('../store', () => ({
  useFileStore: mocks.useFileStore,
}));

vi.mock('../utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

vi.mock('./UpdateStatus', () => ({
  UpdateStatus: () => <div data-testid="update-status" />,
}));

function storeSetter(key: string) {
  return vi.fn((value: unknown) => {
    mocks.state[key] = value;
  });
}

function createStoreState(overrides: MockState = {}): MockState {
  return {
    theme: 'dark',
    setTheme: storeSetter('theme'),
    accent: 'blue',
    setAccent: storeSetter('accent'),
    accentCustom: '#7cc7ff',
    setAccentCustom: vi.fn((value: unknown) => {
      mocks.state.accent = 'custom';
      mocks.state.accentCustom = value;
    }),
    density: 'comfortable',
    setDensity: storeSetter('density'),
    uiScale: 1,
    setUiScale: storeSetter('uiScale'),
    font: 'mono',
    setFont: storeSetter('font'),
    fontCustom: '',
    setFontCustom: vi.fn((value: unknown) => {
      mocks.state.font = 'custom';
      mocks.state.fontCustom = value;
    }),
    importedFonts: [],
    addImportedFont: vi.fn((font: unknown) => {
      mocks.state.importedFonts = [...(mocks.state.importedFonts as unknown[]), font];
    }),
    removeImportedFont: vi.fn(),
    borderRadius: 0,
    setBorderRadius: storeSetter('borderRadius'),
    iconSize: 14,
    setIconSize: storeSetter('iconSize'),
    reduceMotion: false,
    setReduceMotion: storeSetter('reduceMotion'),
    listRowHeight: 34,
    setListRowHeight: storeSetter('listRowHeight'),
    gridMinWidth: 140,
    setGridMinWidth: storeSetter('gridMinWidth'),
    showHidden: false,
    setShowHidden: storeSetter('showHidden'),
    showPreviewPanel: false,
    setShowPreviewPanel: storeSetter('showPreviewPanel'),
    showStatusBar: true,
    setShowStatusBar: storeSetter('showStatusBar'),
    showFolderSizes: false,
    setShowFolderSizes: storeSetter('showFolderSizes'),
    enableDnDLargeLists: false,
    setEnableDnDLargeLists: storeSetter('enableDnDLargeLists'),
    previewExecutableScripts: false,
    setPreviewExecutableScripts: storeSetter('previewExecutableScripts'),
    devMockEntries: false,
    setDevMockEntries: storeSetter('devMockEntries'),
    defaultExplorerSupported: false,
    defaultExplorerEnabled: null,
    defaultExplorerLoading: false,
    defaultExplorerError: null,
    refreshDefaultExplorer: vi.fn(async () => null),
    makeDefaultExplorer: vi.fn(async () => {}),
    revertDefaultExplorer: vi.fn(async () => {}),
    clearDefaultExplorerError: vi.fn(),
    confirmBeforeDelete: true,
    setConfirmBeforeDelete: storeSetter('confirmBeforeDelete'),
    enableErrorReporting: false,
    setEnableErrorReporting: storeSetter('enableErrorReporting'),
    themes: {},
    saveTheme: vi.fn(),
    deleteTheme: vi.fn(),
    applyThemeSpec: vi.fn(),
    ...overrides,
  };
}

function renderPanel(stateOverrides: MockState = {}, open = true) {
  mocks.state = createStoreState(stateOverrides);
  const onClose = vi.fn();

  return {
    user: userEvent.setup(),
    onClose,
    ...render(<SettingsPanel open={open} onClose={onClose} />),
  };
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue([]);
    mocks.reportError.mockReset();
    mocks.state = createStoreState();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render while closed and closes from available escape paths', async () => {
    const closed = renderPanel({}, false);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    closed.unmount();

    const { user, onClose, container } = renderPanel();

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /close settings/i }));
    fireEvent.mouseDown(container.firstElementChild as Element);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('exposes preferences-style vertical settings navigation', () => {
    renderPanel();

    const tablist = screen.getByRole('tablist', { name: 'Settings Tabs' });

    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('updates general settings from checkbox controls', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.click(screen.getByLabelText(/Right preview panel/i));
    await user.click(screen.getByLabelText(/Show hidden files/i));
    await user.click(screen.getByLabelText(/Show status bar/i));
    await user.click(screen.getByLabelText(/Show folder sizes/i));
    await user.click(screen.getByLabelText(/Confirm before delete/i));
    await user.click(screen.getByLabelText(/Error reporting/i));

    expect(mocks.state.setShowPreviewPanel).toHaveBeenCalledWith(true);
    expect(mocks.state.setShowHidden).toHaveBeenCalledWith(true);
    expect(mocks.state.setShowStatusBar).toHaveBeenCalledWith(false);
    expect(mocks.state.setShowFolderSizes).toHaveBeenCalledWith(true);
    expect(mocks.state.setConfirmBeforeDelete).toHaveBeenCalledWith(false);
    expect(mocks.state.setEnableErrorReporting).toHaveBeenCalledWith(true);
  });

  it('updates appearance choices and imports a Google font by family name', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByTitle('Light'));
    await user.click(screen.getByRole('button', { name: 'green' }));
    fireEvent.change(screen.getByTitle('Pick custom accent'), {
      target: { value: '#123456' },
    });
    await user.click(screen.getByRole('button', { name: /Compact/i }));
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '1.12' } });
    fireEvent.change(screen.getAllByRole('slider')[1], { target: { value: '40' } });
    fireEvent.change(screen.getAllByRole('slider')[2], { target: { value: '180' } });

    await user.type(screen.getByPlaceholderText('Family name (e.g., Inter)'), 'Inter');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(mocks.state.setTheme).toHaveBeenCalledWith('light');
    expect(mocks.state.setAccent).toHaveBeenCalledWith('green');
    expect(mocks.state.setAccentCustom).toHaveBeenCalledWith('#123456');
    expect(mocks.state.setDensity).toHaveBeenCalledWith('compact');
    expect(mocks.state.setUiScale).toHaveBeenCalledWith(1.12);
    expect(mocks.state.setListRowHeight).toHaveBeenCalledWith(40);
    expect(mocks.state.setGridMinWidth).toHaveBeenCalledWith(180);
    expect(mocks.state.addImportedFont).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Inter',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
      })
    );
    expect(mocks.state.setFont).toHaveBeenCalledWith('custom');
    expect(mocks.state.setFontCustom).toHaveBeenCalledWith('Inter');
    expect(screen.getByText('Manage fonts')).toBeVisible();
  });

  it('saves, applies, and imports theme presets', async () => {
    const { user } = renderPanel({
      themes: {
        Solarized: {
          theme: 'light',
          accent: 'orange',
          accentCustom: '#ffb86b',
          density: 'comfortable',
          uiScale: 1,
          listRowHeight: 34,
          gridMinWidth: 140,
          font: 'system',
          fontCustom: '',
          borderRadius: 4,
          iconSize: 14,
          reduceMotion: false,
        },
      },
    });

    await user.click(screen.getByRole('tab', { name: 'Themes' }));
    await user.type(screen.getByPlaceholderText('Theme name'), 'Default');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Name "Default" is reserved')).toBeVisible();

    await user.clear(screen.getByPlaceholderText('Theme name'));
    await user.type(screen.getByPlaceholderText('Theme name'), 'Night Shift');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.state.saveTheme).toHaveBeenCalledWith('Night Shift');

    const solarized = screen.getByText('Solarized').closest('span') as HTMLElement;
    await user.click(withinElement(solarized, 'Apply'));
    await user.click(withinElement(solarized, 'Delete'));

    expect(mocks.state.applyThemeSpec).toHaveBeenCalledWith(
      expect.objectContaining({ accent: 'orange' })
    );
    expect(mocks.state.deleteTheme).toHaveBeenCalledWith('Solarized');

    fireEvent.change(
      screen.getByPlaceholderText('Paste JSON for a theme spec or a map of themes'),
      {
        target: {
          value: JSON.stringify({
            theme: 'dark',
            accent: 'purple',
            accentCustom: '#b39ddb',
            density: 'compact',
            uiScale: 1,
            listRowHeight: 32,
            gridMinWidth: 160,
            font: 'mono',
            borderRadius: 8,
            iconSize: 16,
            reduceMotion: true,
          }),
        },
      }
    );
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(mocks.state.saveTheme).toHaveBeenCalledWith(
      'Night Shift',
      expect.objectContaining({ accent: 'purple' })
    );
    expect(await screen.findByText('Imported as: Night Shift')).toBeVisible();
  });

  it('runs default explorer actions when the integration is available', async () => {
    const { user } = renderPanel({
      defaultExplorerSupported: true,
      defaultExplorerEnabled: false,
      refreshDefaultExplorer: vi.fn(async () => false),
      makeDefaultExplorer: vi.fn(async () => {}),
      revertDefaultExplorer: vi.fn(async () => {}),
    });

    await waitFor(() => expect(mocks.state.refreshDefaultExplorer).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));

    expect(screen.getByText('Windows Explorer is currently the default explorer.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Make explorie default' }));

    expect(mocks.state.clearDefaultExplorerError).toHaveBeenCalled();
    expect(mocks.state.makeDefaultExplorer).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('explorie is now the default file manager.')).toBeVisible();
  });

  it('loads plugin metadata and invokes the selected plugin method', async () => {
    mocks.invoke.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === 'list_plugins') return ['info'];
      if (command === 'get_plugin_methods') return ['describe'];
      if (command === 'call_plugin') {
        return {
          ok: true,
          payload,
        };
      }
      throw new Error(`Unexpected command ${command}`);
    });

    const { user } = renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Plugins' }));

    expect(await screen.findByDisplayValue('info')).toBeVisible();
    expect(await screen.findByDisplayValue('describe')).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText('{"key": "value"}'), {
      target: { value: '{bad' },
    });
    await user.click(screen.getByRole('button', { name: 'Invoke' }));
    expect(await screen.findByText('Error: Invalid JSON payload')).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText('{"key": "value"}'), {
      target: { value: '{"answer":42}' },
    });
    await user.click(screen.getByRole('button', { name: 'Invoke' }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('call_plugin', {
        plugin: 'info',
        method: 'describe',
        payload: { answer: 42 },
      })
    );
    expect(await screen.findByText(/"ok": true/)).toBeVisible();
  });
});

function withinElement(element: HTMLElement, name: string) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent === name
  ) as HTMLButtonElement;
}
