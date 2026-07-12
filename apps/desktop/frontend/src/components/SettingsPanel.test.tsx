import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

type MockState = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const data = {
    state: {} as MockState,
    invoke: vi.fn(),
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

vi.mock('../store', () => ({
  useFileStore: mocks.useFileStore,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
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
    borderRadius: 0,
    setBorderRadius: storeSetter('borderRadius'),
    iconSize: 14,
    setIconSize: storeSetter('iconSize'),
    reduceMotion: false,
    setReduceMotion: storeSetter('reduceMotion'),
    highContrast: false,
    setHighContrast: storeSetter('highContrast'),
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
    remoteDrivesEnabled: false,
    setRemoteDrivesEnabled: storeSetter('remoteDrivesEnabled'),
    showFolderSizes: false,
    setShowFolderSizes: storeSetter('showFolderSizes'),
    previewExecutableScripts: false,
    setPreviewExecutableScripts: storeSetter('previewExecutableScripts'),
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
    mocks.state = createStoreState();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_system_integration_status') {
        return Promise.resolve({ supported: true, enabled: false });
      }
      if (command === 'set_system_integration') {
        return Promise.resolve({ supported: true, enabled: true });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
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
    await user.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(container.firstElementChild as Element);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('exposes clear section navigation', () => {
    renderPanel();

    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const sectionButtons = navigation.querySelectorAll('button');

    expect(sectionButtons).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not expose prototype controls', async () => {
    const { user } = renderPanel();

    expect(screen.queryByRole('button', { name: 'Plugins' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /Drag and drop on large lists/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Preview executable scripts/i })).toBeVisible();
    expect(screen.queryByText('Environment')).not.toBeInTheDocument();
    expect(screen.queryByText('Dev: mock entries')).not.toBeInTheDocument();
    expect(screen.queryByText('Default explorer')).not.toBeInTheDocument();
  });

  it('opts into reversible Windows folder integration', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'System Integration' }));
    const checkbox = await screen.findByRole('checkbox', { name: /Open folders with Explorie/i });
    await user.click(checkbox);

    expect(mocks.invoke).toHaveBeenCalledWith('set_system_integration', { enabled: true });
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Windows integration enabled');
  });

  it('updates general settings from checkbox controls', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByLabelText(/Right preview panel/i));
    await user.click(screen.getByLabelText(/Show hidden files/i));
    await user.click(screen.getByLabelText(/Show status bar/i));
    await user.click(screen.getByLabelText(/Show folder sizes/i));
    await user.click(screen.getByLabelText(/Enable Remote Drives/i));
    await user.click(screen.getByLabelText(/Confirm before delete/i));
    await user.click(screen.getByLabelText(/Error reporting/i));
    await user.click(screen.getByLabelText(/Preview executable scripts/i));

    expect(mocks.state.setShowPreviewPanel).toHaveBeenCalledWith(true);
    expect(mocks.state.setShowHidden).toHaveBeenCalledWith(true);
    expect(mocks.state.setShowStatusBar).toHaveBeenCalledWith(false);
    expect(mocks.state.setShowFolderSizes).toHaveBeenCalledWith(true);
    expect(mocks.state.setRemoteDrivesEnabled).toHaveBeenCalledWith(true);
    expect(mocks.state.setConfirmBeforeDelete).toHaveBeenCalledWith(false);
    expect(mocks.state.setEnableErrorReporting).toHaveBeenCalledWith(true);
    expect(mocks.state.setPreviewExecutableScripts).toHaveBeenCalledWith(true);
    expect(screen.getByText(/nothing is sent/i)).toBeVisible();
  });

  it('updates appearance choices without exposing remote font imports', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByTitle('Light'));
    await user.click(screen.getByRole('button', { name: 'green' }));
    fireEvent.change(screen.getByTitle('Pick custom accent'), {
      target: { value: '#123456' },
    });
    await user.click(screen.getByRole('button', { name: /Compact/i }));
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '1.12' } });
    fireEvent.change(screen.getAllByRole('slider')[1], { target: { value: '40' } });
    fireEvent.change(screen.getAllByRole('slider')[2], { target: { value: '180' } });
    await user.click(screen.getByLabelText('Reduce motion'));
    await user.click(screen.getByLabelText('High contrast'));

    expect(mocks.state.setTheme).toHaveBeenCalledWith('light');
    expect(mocks.state.setAccent).toHaveBeenCalledWith('green');
    expect(mocks.state.setAccentCustom).toHaveBeenCalledWith('#123456');
    expect(mocks.state.setDensity).toHaveBeenCalledWith('compact');
    expect(mocks.state.setUiScale).toHaveBeenCalledWith(1.12);
    expect(mocks.state.setListRowHeight).toHaveBeenCalledWith(40);
    expect(mocks.state.setGridMinWidth).toHaveBeenCalledWith(180);
    expect(mocks.state.setReduceMotion).toHaveBeenCalledWith(true);
    expect(mocks.state.setHighContrast).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Import font')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Google Fonts/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('UI scale')).toHaveAttribute('max', '1.4');
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

    await user.click(screen.getByRole('button', { name: 'Themes' }));
    await user.type(screen.getByLabelText('Theme name'), 'Default');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Name "Default" is reserved')).toBeVisible();

    await user.clear(screen.getByLabelText('Theme name'));
    await user.type(screen.getByLabelText('Theme name'), 'Night Shift');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocks.state.saveTheme).toHaveBeenCalledWith('Night Shift');

    const solarized = screen.getByText('Solarized').closest('span') as HTMLElement;
    await user.click(withinElement(solarized, 'Apply'));
    await user.click(withinElement(solarized, 'Delete'));

    expect(mocks.state.applyThemeSpec).toHaveBeenCalledWith(
      expect.objectContaining({ accent: 'orange' })
    );
    expect(mocks.state.deleteTheme).toHaveBeenCalledWith('Solarized');

    fireEvent.change(screen.getByLabelText('Theme JSON'), {
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
    });
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(mocks.state.saveTheme).toHaveBeenCalledWith(
      'Night Shift',
      expect.objectContaining({ accent: 'purple' })
    );
    expect(await screen.findByText('Imported as: Night Shift')).toBeVisible();

    (mocks.state.saveTheme as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.change(screen.getByLabelText('Theme JSON'), {
      target: {
        value: JSON.stringify({
          Valid: themeSpecForTest(),
          Invalid: { ...themeSpecForTest(), accent: 'javascript:' },
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(mocks.state.saveTheme).not.toHaveBeenCalled();
    expect(await screen.findByText(/contains an invalid name or theme/i)).toBeVisible();
  });

  it('resets every exposed setting and reports completion', async () => {
    const { user } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(mocks.state.setFontCustom).toHaveBeenCalledWith('');
    expect(mocks.state.setShowStatusBar).toHaveBeenCalledWith(true);
    expect(mocks.state.setRemoteDrivesEnabled).toHaveBeenCalledWith(false);
    expect(mocks.state.setConfirmBeforeDelete).toHaveBeenCalledWith(true);
    expect(mocks.state.setEnableErrorReporting).toHaveBeenCalledWith(false);
    expect(mocks.state.setListRowHeight).toHaveBeenCalledWith(34);
    expect(mocks.state.setGridMinWidth).toHaveBeenCalledWith(140);
    expect(screen.getByRole('status')).toHaveTextContent('Settings restored to defaults');
  });
});

function withinElement(element: HTMLElement, name: string) {
  return Array.from(element.querySelectorAll('button')).find(
    (button) => button.textContent === name
  ) as HTMLButtonElement;
}

function themeSpecForTest() {
  return {
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
  };
}
