import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '../services/updater';
import { AutoUpdater } from './AutoUpdater';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  isTauriRuntime: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../updateStore', () => ({
  useUpdateStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
}));

vi.mock('../services/updater', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
}));

vi.mock('./Toast', () => ({
  useToast: () => ({
    show: mocks.showToast,
  }),
}));

const updateInfo: UpdateInfo = {
  version: '0.2.0',
  notes: 'Update notes',
  publishedAt: '2026-06-03T00:00:00Z',
  downloadUrl: 'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
  assetName: 'explorie-portable.exe',
};

function resetState(overrides: Partial<Record<string, unknown>> = {}) {
  mocks.state = {
    loadCurrentVersion: vi.fn(async () => {}),
    checkNow: vi.fn(async () => null),
    downloadNow: vi.fn(async () => null),
    installNow: vi.fn(async () => {}),
    status: 'idle',
    updateInfo: null,
    error: null,
    clearError: vi.fn(),
    ...overrides,
  };
}

describe('AutoUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriRuntime.mockReturnValue(false);
    resetState();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the current version without checking for updates outside Tauri', async () => {
    render(<AutoUpdater />);

    await waitFor(() => expect(mocks.state.loadCurrentVersion).toHaveBeenCalledTimes(1));
    expect(mocks.isTauriRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.state.checkNow).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('checks and downloads updates automatically in the Tauri runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    resetState({
      checkNow: vi.fn(async () => updateInfo),
      downloadNow: vi.fn(async () => 'explorie-updates/explorie-0.2.0.exe'),
    });

    render(<AutoUpdater />);

    await waitFor(() => expect(mocks.state.checkNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.state.downloadNow).toHaveBeenCalledWith(updateInfo));
  });

  it('prompts for a ready update and installs on confirmation', async () => {
    const user = userEvent.setup();
    resetState({
      status: 'ready',
      updateInfo,
    });

    render(<AutoUpdater />);

    expect(await screen.findByRole('alertdialog', { name: 'Update ready' })).toBeInTheDocument();
    expect(
      screen.getByText('explorie 0.2.0 is ready to install. Restart to apply the update?')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restart now' }));

    expect(mocks.state.installNow).toHaveBeenCalledTimes(1);
  });

  it('reports update errors and clears them', async () => {
    resetState({
      status: 'error',
      error: 'download failed',
    });

    render(<AutoUpdater />);

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith('Update failed: download failed', {
        type: 'error',
      })
    );
    expect(mocks.state.clearError).toHaveBeenCalledTimes(1);
  });
});
