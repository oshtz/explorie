import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageMetadataInspector } from './ImageMetadataInspector';
import type { ImageMetadata } from '../utils/imageMetadata';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (path: string) => mocks.readFile(path),
}));

function renderInspector(metadata: ImageMetadata, path = '/photos/shot.jpg') {
  return render(<ImageMetadataInspector path={path} metadata={metadata} />);
}

describe('ImageMetadataInspector', () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.readFile.mockRejectedValue(new Error('not used'));
  });

  afterEach(() => {
    cleanup();
  });

  it('shows camera, date and dimensions from EXIF', () => {
    renderInspector({
      camera: 'Canon EOS R5',
      date: '2024:03:15 14:30:00',
      width: 4032,
      height: 3024,
    });

    expect(screen.getByText('Camera:')).toBeVisible();
    expect(screen.getByText('Canon EOS R5')).toBeVisible();
    expect(screen.getByText('Taken:')).toBeVisible();
    expect(screen.getByText('Dimensions:')).toBeVisible();
    expect(screen.getByText('4032 × 3024')).toBeVisible();
  });

  it('shows IPTC caption and keywords', () => {
    renderInspector({
      caption: 'Harbor at dusk',
      keywords: ['travel', 'boats'],
    });

    expect(screen.getByText('Caption:')).toBeVisible();
    expect(screen.getByText('Harbor at dusk')).toBeVisible();
    expect(screen.getByText('Keywords:')).toBeVisible();
    expect(screen.getByText('travel, boats')).toBeVisible();
  });

  it('shows an empty state when capture metadata is missing', async () => {
    mocks.readFile.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

    render(<ImageMetadataInspector path="/photos/plain.jpg" />);

    expect(await screen.findByRole('status')).toHaveTextContent('No camera or caption metadata');
  });

  it('keeps GPS collapsed until the user expands it', async () => {
    const user = userEvent.setup();
    renderInspector({
      camera: 'Sony',
      gps: { latitude: 37.7749, longitude: -122.4194 },
    });

    const coords = screen.getByText('37.774900, -122.419400');
    expect(coords).not.toBeVisible();
    expect(screen.getByText('Show location')).toBeVisible();

    await user.click(screen.getByText('Show location'));
    expect(coords).toBeVisible();
  });

  it('uses an empty state rather than an error when the file cannot be read', async () => {
    mocks.readFile.mockRejectedValue(new Error('permission denied'));

    render(<ImageMetadataInspector path="/photos/locked.jpg" />);

    expect(await screen.findByRole('status')).toHaveTextContent('No camera or caption metadata');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
