import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageMetadataEditor } from './ImageMetadataEditor';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

const initialMetadata = {
  format: 'JPEG',
  supported: true,
  width: 4032,
  height: 3024,
  exif: [
    {
      key: 'exif:GENERIC:010E',
      label: 'Image Description',
      value: 'Before',
      editable: true,
    },
  ],
  iptc: [
    {
      key: 'iptc:2:105',
      label: 'Headline',
      value: 'Original headline',
      editable: true,
    },
  ],
};

const savedMetadata = {
  ...initialMetadata,
  exif: [{ ...initialMetadata.exif[0], value: 'After' }],
  iptc: [{ ...initialMetadata.iptc[0], value: 'Updated headline' }],
};

describe('ImageMetadataEditor', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'read_image_metadata' ? initialMetadata : savedMetadata)
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('loads EXIF/IPTC values and persists edited metadata', async () => {
    const user = userEvent.setup();
    render(<ImageMetadataEditor path="/photos/sample.jpg" />);

    const description = await screen.findByRole('textbox', { name: 'Description' });
    expect(description).toHaveValue('Before');
    expect(screen.getByText('EXIF')).toBeVisible();
    expect(screen.getByText('IPTC')).toBeVisible();
    expect(screen.getByText('4032 × 3024')).toBeVisible();

    await user.clear(description);
    await user.type(description, 'After');
    await user.click(screen.getByRole('button', { name: 'Save metadata' }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('write_image_metadata', {
        path: '/photos/sample.jpg',
        updates: expect.arrayContaining([
          { key: 'exif:GENERIC:010E', value: 'After' },
          { key: 'iptc:2:105', value: 'Original headline' },
        ]),
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Metadata saved.');
    expect(description).toHaveValue('After');
  });

  it('shows an empty state instead of an error for an unsupported image type', async () => {
    mocks.invoke.mockResolvedValue({
      format: 'Unsupported',
      supported: false,
      width: null,
      height: null,
      exif: [],
      iptc: [],
    });
    render(<ImageMetadataEditor path="/photos/sample.gif" />);

    expect(
      await screen.findByText('This image type does not carry EXIF or IPTC metadata.')
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save metadata' })).toBeNull();
  });

  it('shows an empty state for a supported image that carries no metadata', async () => {
    mocks.invoke.mockResolvedValue({
      format: 'PNG',
      supported: true,
      width: 8,
      height: 6,
      exif: [],
      iptc: [],
    });
    render(<ImageMetadataEditor path="/photos/bare.png" />);

    expect(await screen.findByText(/no EXIF or IPTC metadata yet/)).toBeVisible();
    expect(screen.getByText('8 × 6')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
