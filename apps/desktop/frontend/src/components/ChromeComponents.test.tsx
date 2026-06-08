import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoBox } from './InfoBox';
import { SkipLinks } from './SkipLinks';
import { TabsBar } from './TabsBar';
import { ThemeToggle } from './ThemeToggle';
import { TitleBar } from './TitleBar';
import { ViewModeToggle } from './ViewModeToggle';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const tauriWindow = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  startDragging: vi.fn(),
  toggleMaximize: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => tauriWindow),
}));

describe('small chrome components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('renders InfoBox content and handles close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<InfoBox onClose={onClose} />);

    expect(screen.getByText('Welcome to explorie')).toBeInTheDocument();
    expect(
      screen.getByText('This is a placeholder. Feature disabled for now.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches theme choices', async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();

    render(<ThemeToggle theme="dark" setTheme={setTheme} />);

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(setTheme).toHaveBeenCalledWith('light');

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('switches view mode choices', async () => {
    const user = userEvent.setup();
    const setViewMode = vi.fn();

    render(<ViewModeToggle viewMode="list" setViewMode={setViewMode} />);

    await user.click(screen.getByRole('button', { name: 'Column' }));
    await user.click(screen.getByRole('button', { name: 'Grid' }));
    await user.click(screen.getByRole('button', { name: 'List' }));

    expect(setViewMode).toHaveBeenNthCalledWith(1, 'column');
    expect(setViewMode).toHaveBeenNthCalledWith(2, 'grid');
    expect(setViewMode).toHaveBeenNthCalledWith(3, 'list');
  });

  it('renders tabs and supports activation, close, middle-click close, keyboard close, and add', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const onAdd = vi.fn();

    render(
      <TabsBar
        tabs={[
          { id: 'tab-root', path: 'C:/' },
          { id: 'tab-project', path: 'C:/work/explorie' },
        ]}
        activeTabId="tab-root"
        onActivate={onActivate}
        onClose={onClose}
        onAdd={onAdd}
      />
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('C:/')).toBeInTheDocument();
    expect(screen.getByText('explorie')).toBeInTheDocument();

    await user.click(tabs[1]);
    expect(onActivate).toHaveBeenCalledWith('tab-project');

    fireEvent.mouseDown(tabs[1], { button: 1 });
    expect(onClose).toHaveBeenCalledWith('tab-project');

    fireEvent.keyDown(tabs[0], { key: 'Delete' });
    expect(onClose).toHaveBeenCalledWith('tab-root');

    await user.click(screen.getAllByTitle('Close tab')[1]);
    expect(onClose).toHaveBeenCalledWith('tab-project');

    await user.click(screen.getByTitle('New tab (Ctrl/Cmd+T)'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('renders TitleBar controls only under Tauri and dispatches window actions', async () => {
    const user = userEvent.setup();

    const { container, rerender } = render(<TitleBar />);
    expect(screen.getByText('explorie')).toBeInTheDocument();
    expect(screen.queryByTitle('Minimize')).not.toBeInTheDocument();

    window.__TAURI_INTERNALS__ = {};
    rerender(<TitleBar />);

    fireEvent.mouseDown(container.firstElementChild as Element, { button: 0 });
    expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTitle('Minimize'));
    await user.click(screen.getByTitle('Maximize/Restore'));
    await user.click(screen.getByTitle('Close'));

    expect(tauriWindow.minimize).toHaveBeenCalledTimes(1);
    expect(tauriWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(tauriWindow.close).toHaveBeenCalledTimes(1);
  });

  it('focuses skip-link targets and leaves missing targets alone', async () => {
    const user = userEvent.setup();
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.appendChild(main);

    render(
      <SkipLinks
        links={[
          { id: 'main-content', label: 'Skip to main' },
          { id: 'missing-section', label: 'Skip missing' },
        ]}
      />
    );

    await user.click(screen.getByRole('link', { name: 'Skip to main' }));
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(main);

    const missingLink = screen.getByRole('link', { name: 'Skip missing' });
    await user.click(missingLink);
    expect(document.getElementById('missing-section')).toBeNull();
    expect(document.activeElement).toBe(missingLink);
  });
});
