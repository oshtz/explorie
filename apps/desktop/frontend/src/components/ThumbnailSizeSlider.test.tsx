import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileStore } from '../store';
import { ThumbnailSizeSlider, useThumbnailSizeShortcuts } from './ThumbnailSizeSlider';

function ShortcutHarness() {
  const { increase, decrease } = useThumbnailSizeShortcuts();
  const gridMinWidth = useFileStore((state) => state.gridMinWidth);

  return (
    <div>
      <span>{gridMinWidth}px</span>
      <button type="button" onClick={decrease}>
        Decrease
      </button>
      <button type="button" onClick={increase}>
        Increase
      </button>
    </div>
  );
}

describe('ThumbnailSizeSlider', () => {
  beforeEach(() => {
    useFileStore.setState({ gridMinWidth: 160 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders presets and updates the thumbnail size from preset buttons', async () => {
    const user = userEvent.setup();

    render(<ThumbnailSizeSlider />);

    expect(screen.getByText('160px')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'L' }));

    expect(useFileStore.getState().gridMinWidth).toBe(200);
    expect(screen.getByText('200px')).toBeVisible();
  });

  it('updates thumbnail size from the range input', () => {
    render(<ThumbnailSizeSlider />);

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '230' } });

    expect(useFileStore.getState().gridMinWidth).toBe(230);
    expect(screen.getByText('230px')).toBeVisible();
    expect(slider).toHaveAttribute('title', 'Thumbnail size: 230px');
  });

  it('supports compact mode without presets or the size label', () => {
    render(<ThumbnailSizeSlider compact />);

    expect(screen.queryByRole('button', { name: 'S' })).not.toBeInTheDocument();
    expect(screen.queryByText('160px')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider'), { target: { value: '180' } });

    expect(useFileStore.getState().gridMinWidth).toBe(180);
  });

  it('exposes keyboard shortcut helpers with min and max clamping', async () => {
    const user = userEvent.setup();

    const { rerender } = render(<ShortcutHarness />);

    await user.click(screen.getByRole('button', { name: 'Increase' }));
    expect(useFileStore.getState().gridMinWidth).toBe(170);

    useFileStore.setState({ gridMinWidth: 260 });
    rerender(<ShortcutHarness />);
    await user.click(screen.getByRole('button', { name: 'Increase' }));
    expect(useFileStore.getState().gridMinWidth).toBe(260);

    useFileStore.setState({ gridMinWidth: 120 });
    rerender(<ShortcutHarness />);
    await user.click(screen.getByRole('button', { name: 'Decrease' }));
    expect(useFileStore.getState().gridMinWidth).toBe(120);
  });
});
