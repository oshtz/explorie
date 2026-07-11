import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabsBar } from './TabsBar';

describe('TabsBar keyboard navigation', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('moves focus and activates tabs with arrow keys', () => {
    const onActivate = vi.fn();
    render(
      <TabsBar
        tabs={[
          { id: 'one', path: '/one' },
          { id: 'two', path: '/two' },
        ]}
        activeTabId="one"
        onActivate={onActivate}
        onClose={vi.fn()}
        onAdd={vi.fn()}
      />
    );

    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(onActivate).toHaveBeenCalledWith('two');
    expect(tabs[1]).toHaveFocus();
    expect(tabs[0].querySelector('button')).toBeNull();
  });

  it('reorders tabs by drag and exposes file drops with hover-open', () => {
    vi.useFakeTimers();
    const onActivate = vi.fn();
    const onReorder = vi.fn();
    const onFileDragHover = vi.fn();
    const { rerender } = render(
      <TabsBar
        tabs={[
          { id: 'one', path: '/one' },
          { id: 'two', path: '/two' },
        ]}
        activeTabId="one"
        onActivate={onActivate}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onReorder={onReorder}
      />
    );
    const wrappers = screen.getAllByRole('tab').map((tab) => tab.parentElement!);
    const transfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => 'one'),
    };
    fireEvent.dragStart(wrappers[0], { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith('application/x-explorie-tab', 'one');
    fireEvent.dragOver(wrappers[1], { dataTransfer: transfer });
    fireEvent.drop(wrappers[1], { dataTransfer: transfer });
    expect(onReorder).toHaveBeenCalledWith('one', 'two');

    rerender(
      <TabsBar
        tabs={[
          { id: 'one', path: '/one' },
          { id: 'two', path: '/two' },
        ]}
        activeTabId="one"
        onActivate={onActivate}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        fileDragActive
        onFileDragHover={onFileDragHover}
      />
    );
    fireEvent.mouseEnter(screen.getAllByRole('tab')[1].parentElement!);
    expect(onFileDragHover).toHaveBeenCalledWith('/two');
    vi.advanceTimersByTime(700);
    expect(onActivate).toHaveBeenCalledWith('two');
  });
});
