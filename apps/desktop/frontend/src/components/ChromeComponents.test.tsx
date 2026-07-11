import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkipLinks } from './SkipLinks';
import { TabsBar } from './TabsBar';
import { ThemeToggle } from './ThemeToggle';
import { getTitleBarState, TitleBar } from './TitleBar';
import { ViewModeToggle } from './ViewModeToggle';

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}));

describe('small chrome components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
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

  it('connects the custom title bar to the native window controls', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<TitleBar />);

    fireEvent.doubleClick(container.firstElementChild as Element);
    await user.click(screen.getByRole('button', { name: 'Minimize window' }));
    await user.click(screen.getByRole('button', { name: 'Maximize or restore window' }));
    await user.click(screen.getByRole('button', { name: 'Close window' }));

    expect(windowMocks.minimize).toHaveBeenCalledOnce();
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(2);
    expect(windowMocks.close).toHaveBeenCalledOnce();

    rerender(<TitleBar showWindowControls={false} />);
    expect(screen.getByText('explorie')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument();
    fireEvent.doubleClick(container.firstElementChild as Element);
    expect(windowMocks.toggleMaximize).toHaveBeenCalledTimes(2);
  });

  it('uses native macOS chrome and fails closed to custom Tauri chrome', () => {
    expect(getTitleBarState('macos', true)).toEqual({
      showTitleBar: false,
      showWindowControls: false,
    });
    expect(getTitleBarState('windows', true)).toEqual({
      showTitleBar: true,
      showWindowControls: true,
    });
    expect(getTitleBarState('unknown', true)).toEqual({
      showTitleBar: true,
      showWindowControls: true,
    });
    expect(getTitleBarState('web', false)).toEqual({
      showTitleBar: true,
      showWindowControls: false,
    });
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
