import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateStatus } from './UpdateStatus';
import { useUpdateStore } from '../updateStore';
import type { UpdateInfo } from '../services/updater';

const updateInfo: UpdateInfo = {
  version: '0.2.0',
  notes: 'Improved update flow',
  publishedAt: '2026-06-02T00:00:00Z',
  downloadUrl: 'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
  assetName: 'explorie-portable.exe',
};

const loadCurrentVersion = vi.fn(async () => {});
const checkNow = vi.fn(async () => null);
const downloadNow = vi.fn(async () => null);
const installNow = vi.fn(async () => {});

function resetUpdateStatusState() {
  useUpdateStore.setState({
    currentVersion: '0.1.0',
    status: 'idle',
    updateInfo: null,
    updatePath: null,
    error: null,
    lastCheckedAt: null,
    loadCurrentVersion,
    checkNow,
    downloadNow,
    installNow,
  });
}

describe('UpdateStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdateStatusState();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads the current version and starts a manual update check', async () => {
    const user = userEvent.setup();

    render(<UpdateStatus />);

    expect(loadCurrentVersion).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('shows available update details and downloads from the action button', async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({
      status: 'available',
      updateInfo,
      lastCheckedAt: Date.parse('2026-06-02T12:00:00Z'),
    });

    render(<UpdateStatus />);

    expect(screen.getByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('0.2.0')).toBeInTheDocument();
    expect(screen.getByText('Improved update flow')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download update' }));

    expect(downloadNow).toHaveBeenCalledTimes(1);
  });

  it('shows install and error states', async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({
      status: 'ready',
      updateInfo,
      updatePath: 'explorie-updates/explorie-0.2.0.exe',
      error: 'last attempt failed',
    });

    render(<UpdateStatus />);

    expect(screen.getByText('Ready to install')).toBeInTheDocument();
    expect(screen.getByText('last attempt failed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Install update' }));

    expect(installNow).toHaveBeenCalledTimes(1);
  });
});
