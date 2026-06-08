import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announce,
  announceNavigation,
  announceOperation,
  announceSelection,
  createFocusTrap,
  formatShortcut,
  getAnimationDuration,
  getAriaKeyShortcuts,
  getFocusableElements,
  getMenuButtonProps,
  getMenuItemProps,
  getMenuProps,
  getNextIndex,
  getSelectableRowProps,
  getSortableColumnProps,
  prefersReducedMotion,
} from './accessibility';

describe('accessibility utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces messages and reuses the live region', () => {
    announce('Loading files', 'assertive');
    let region = document.querySelector('[role="status"]') as HTMLElement;

    expect(region).toBeInTheDocument();
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('Loading files');

    announceSelection(0, 10);
    expect(region.textContent).toBe('Selection cleared');

    announceSelection(10, 10);
    expect(region.textContent).toBe('All 10 items selected');

    announceSelection(3, 10);
    expect(region.textContent).toBe('3 of 10 items selected');

    announceOperation('Copy', true, '2 files');
    expect(region.textContent).toBe('Copy completed: 2 files');

    announceOperation('Move', false);
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('Move failed');

    announceNavigation('/Users/alex/Documents');
    expect(region.textContent).toBe('Navigated to Documents');

    document.body.removeChild(region);
    announce('Recreated');
    region = document.querySelector('[role="status"]') as HTMLElement;
    expect(region.textContent).toBe('Recreated');
  });

  it('calculates grid navigation indexes with and without wrapping', () => {
    expect(getNextIndex('ArrowDown', { itemCount: 8, columns: 3, currentIndex: 1 })).toBe(4);
    expect(getNextIndex('ArrowDown', { itemCount: 8, columns: 3, currentIndex: 6 })).toBe(6);
    expect(
      getNextIndex('ArrowDown', { itemCount: 8, columns: 3, currentIndex: 7, wrap: true })
    ).toBe(1);

    expect(getNextIndex('ArrowUp', { itemCount: 8, columns: 3, currentIndex: 1 })).toBe(1);
    expect(getNextIndex('ArrowUp', { itemCount: 8, columns: 3, currentIndex: 1, wrap: true })).toBe(
      7
    );

    expect(getNextIndex('ArrowRight', { itemCount: 8, columns: 3, currentIndex: 2 })).toBe(2);
    expect(
      getNextIndex('ArrowRight', { itemCount: 8, columns: 3, currentIndex: 2, wrap: true })
    ).toBe(3);
    expect(getNextIndex('ArrowRight', { itemCount: 8, columns: 1, currentIndex: 2 })).toBe(2);

    expect(getNextIndex('ArrowLeft', { itemCount: 8, columns: 3, currentIndex: 3 })).toBe(3);
    expect(
      getNextIndex('ArrowLeft', { itemCount: 8, columns: 3, currentIndex: 3, wrap: true })
    ).toBe(2);
    expect(
      getNextIndex('ArrowLeft', { itemCount: 8, columns: 3, currentIndex: 0, wrap: true })
    ).toBe(2);
    expect(getNextIndex('ArrowLeft', { itemCount: 8, columns: 1, currentIndex: 2 })).toBe(2);

    expect(getNextIndex('Home', { itemCount: 8, columns: 3, currentIndex: 4 })).toBe(0);
    expect(getNextIndex('End', { itemCount: 8, columns: 3, currentIndex: 4 })).toBe(7);
    expect(getNextIndex('Home', { itemCount: 0, currentIndex: 0 })).toBe(-1);
  });

  it('finds focusable elements and traps focus at modal boundaries', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();

    const modal = document.createElement('div');
    modal.innerHTML = `
      <button disabled>Disabled</button>
      <button id="first">First</button>
      <a id="link" href="/docs">Docs</a>
      <input id="input" />
      <button id="last">Last</button>
    `;
    document.body.appendChild(modal);

    const focusable = getFocusableElements(modal);
    expect(focusable.map((element) => element.id)).toEqual(['first', 'link', 'input', 'last']);

    const trap = createFocusTrap(modal);
    trap.activate();
    expect(document.activeElement).toBe(focusable[0]);

    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
    const shiftPreventDefault = vi.spyOn(shiftTab, 'preventDefault');
    trap.handleKeyDown(shiftTab);
    expect(document.activeElement).toBe(focusable.at(-1));
    expect(shiftPreventDefault).toHaveBeenCalledTimes(1);

    const tab = new KeyboardEvent('keydown', { key: 'Tab' });
    const tabPreventDefault = vi.spyOn(tab, 'preventDefault');
    trap.handleKeyDown(tab);
    expect(document.activeElement).toBe(focusable[0]);
    expect(tabPreventDefault).toHaveBeenCalledTimes(1);

    const enter = new KeyboardEvent('keydown', { key: 'Enter' });
    trap.handleKeyDown(enter);
    expect(document.activeElement).toBe(focusable[0]);

    trap.deactivate();
    expect(document.activeElement).toBe(opener);
  });

  it('returns ARIA helper props for sortable rows and menus', () => {
    expect(getSortableColumnProps('name', 'name', 'asc')).toEqual({
      'aria-sort': 'ascending',
      'aria-label': 'name, sorted ascending, click to sort descending',
    });
    expect(getSortableColumnProps('size', 'name', 'desc')).toEqual({
      'aria-sort': 'none',
      'aria-label': 'size, click to sort ascending',
    });

    expect(getSelectableRowProps(true, 2, 10)).toEqual({
      'aria-selected': true,
      'aria-rowindex': 3,
      role: 'row',
    });

    expect(getMenuProps(false)).toEqual({ role: 'menu', 'aria-hidden': true });
    expect(getMenuItemProps('Rename')).toEqual({
      role: 'menuitem',
      'aria-label': 'Rename',
      tabIndex: -1,
    });
    expect(getMenuButtonProps(true, 'actions-menu', 'Actions')).toEqual({
      'aria-expanded': true,
      'aria-haspopup': 'menu',
      'aria-controls': 'actions-menu',
      'aria-label': 'Actions',
    });
  });

  it('formats keyboard shortcuts and reduced-motion durations', () => {
    expect(formatShortcut('P', { ctrl: true, shift: true })).toBe('Ctrl+Shift+P');
    expect(formatShortcut('O', { meta: true, alt: true })).toBe('Alt+Cmd+O');
    expect(getAriaKeyShortcuts('P', { ctrl: true, shift: true })).toBe('Control+Shift+P');
    expect(getAriaKeyShortcuts('O', { meta: true, alt: true })).toBe('Alt+Meta+O');

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false }))
    );
    expect(prefersReducedMotion()).toBe(false);
    expect(getAnimationDuration(200)).toBe(200);

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true }))
    );
    expect(prefersReducedMotion()).toBe(true);
    expect(getAnimationDuration(200)).toBe(0);
  });
});
