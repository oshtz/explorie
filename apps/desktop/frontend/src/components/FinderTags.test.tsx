import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinderTags } from './FinderTags';

const finderMocks = vi.hoisted(() => ({
  areAvailable: vi.fn(),
  getTags: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  colors: {
    None: 0,
    Gray: 1,
    Green: 2,
    Purple: 3,
    Blue: 4,
    Yellow: 5,
    Red: 6,
    Orange: 7,
  } as Record<string, number>,
  cssColors: {
    None: 'transparent',
    Gray: '#8E8E93',
    Green: '#34C759',
    Purple: '#AF52DE',
    Blue: '#007AFF',
    Yellow: '#FFCC00',
    Red: '#FF3B30',
    Orange: '#FF9500',
  } as Record<string, string>,
}));

vi.mock('../services/finderIntegration', () => ({
  FINDER_TAG_COLORS: finderMocks.colors,
  FINDER_TAG_CSS_COLORS: finderMocks.cssColors,
  areFinderTagsAvailable: () => finderMocks.areAvailable(),
  getFinderTags: (path: string) => finderMocks.getTags(path),
  addFinderTag: (path: string, tag: string) => finderMocks.addTag(path, tag),
  removeFinderTag: (path: string, tag: string) => finderMocks.removeTag(path, tag),
  parseFinderTag: (tag: string) => {
    const [name, colorIndex = '0'] = tag.split('\n');
    return { name, colorIndex: Number.parseInt(colorIndex, 10) || 0 };
  },
  getColorNameFromIndex: (index: number) =>
    Object.entries(finderMocks.colors).find(([, value]) => value === index)?.[0] ?? 'None',
  createFinderTagWithColor: (name: string, color: string) => {
    const colorIndex = finderMocks.colors[color] ?? 0;
    return colorIndex === 0 ? name : `${name}\n${colorIndex}`;
  },
}));

describe('FinderTags', () => {
  beforeEach(() => {
    finderMocks.areAvailable.mockResolvedValue(true);
    finderMocks.getTags.mockResolvedValue(['Important\n6', 'Plain']);
    finderMocks.addTag.mockResolvedValue(undefined);
    finderMocks.removeTag.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing when Finder tags are unavailable', async () => {
    finderMocks.areAvailable.mockResolvedValue(false);
    const { container } = render(<FinderTags path="/root/report.txt" editable />);

    await waitFor(() => expect(finderMocks.areAvailable).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    expect(finderMocks.getTags).not.toHaveBeenCalled();
  });

  it('loads and displays readonly Finder tags', async () => {
    render(<FinderTags path="/root/report.txt" />);

    expect(await screen.findByText('Important')).toBeInTheDocument();
    expect(screen.getByText('Plain')).toBeInTheDocument();
    expect(finderMocks.getTags).toHaveBeenCalledWith('/root/report.txt');
    expect(screen.queryByRole('button', { name: /remove tag/i })).not.toBeInTheDocument();
  });

  it('adds and removes editable tags', async () => {
    const user = userEvent.setup();
    const onTagsChange = vi.fn();

    render(<FinderTags path="/root/report.txt" editable onTagsChange={onTagsChange} />);

    await screen.findByText('Important');

    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    await user.type(screen.getByPlaceholderText('Tag name...'), 'Review');
    await user.selectOptions(screen.getByRole('combobox'), 'Blue');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(finderMocks.addTag).toHaveBeenCalledWith('/root/report.txt', 'Review\n4');
    expect(onTagsChange).toHaveBeenCalledWith(['Important\n6', 'Plain', 'Review\n4']);
    expect(screen.getByText('Review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove tag Important' }));

    expect(finderMocks.removeTag).toHaveBeenCalledWith('/root/report.txt', 'Important\n6');
    expect(onTagsChange).toHaveBeenLastCalledWith(['Plain', 'Review\n4']);
  });

  it('shows load and mutation errors', async () => {
    const user = userEvent.setup();
    finderMocks.getTags.mockRejectedValueOnce(new Error('Tag read failed'));

    const { rerender } = render(<FinderTags path="/root/report.txt" editable />);

    expect(await screen.findByText('Tag read failed')).toBeInTheDocument();

    finderMocks.getTags.mockResolvedValueOnce(['Important\n6']);
    finderMocks.removeTag.mockRejectedValueOnce(new Error('Remove failed'));
    rerender(<FinderTags path="/root/other.txt" editable />);

    await screen.findByText('Important');
    await user.click(screen.getByRole('button', { name: 'Remove tag Important' }));

    expect(await screen.findByText('Remove failed')).toBeInTheDocument();
  });
});
