import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdateStore } from './updateStore';
import {
  checkForUpdate,
  downloadUpdate,
  getCurrentVersion,
  installUpdate,
  type UpdateInfo,
} from './services/updater';

vi.mock('./services/updater', () => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  getCurrentVersion: vi.fn(),
  installUpdate: vi.fn(),
}));

const mockedGetCurrentVersion = vi.mocked(getCurrentVersion);
const mockedCheckForUpdate = vi.mocked(checkForUpdate);
const mockedDownloadUpdate = vi.mocked(downloadUpdate);
const mockedInstallUpdate = vi.mocked(installUpdate);

const updateInfo: UpdateInfo = {
  version: '0.2.0',
  notes: 'Release notes',
  publishedAt: '2026-06-02T00:00:00Z',
  downloadUrl: 'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
  assetName: 'explorie-portable.exe',
};

function resetUpdateStore() {
  useUpdateStore.setState({
    currentVersion: null,
    status: 'idle',
    updateInfo: null,
    updatePath: null,
    error: null,
    lastCheckedAt: null,
  });
}

describe('useUpdateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'));
    resetUpdateStore();
  });

  it('loads the current version', async () => {
    mockedGetCurrentVersion.mockResolvedValue('0.1.0');

    await useUpdateStore.getState().loadCurrentVersion();

    expect(useUpdateStore.getState().currentVersion).toBe('0.1.0');
    expect(useUpdateStore.getState().error).toBeNull();
  });

  it('records an available update and last checked time', async () => {
    mockedCheckForUpdate.mockResolvedValue(updateInfo);

    await expect(useUpdateStore.getState().checkNow()).resolves.toEqual(updateInfo);

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'available',
      updateInfo,
      updatePath: null,
      error: null,
      lastCheckedAt: Date.parse('2026-06-02T12:00:00Z'),
    });
  });

  it('records an up-to-date check when no update exists', async () => {
    mockedCheckForUpdate.mockResolvedValue(null);

    await expect(useUpdateStore.getState().checkNow()).resolves.toBeNull();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'up-to-date',
      updateInfo: null,
      updatePath: null,
      lastCheckedAt: Date.parse('2026-06-02T12:00:00Z'),
    });
  });

  it('downloads and installs a ready update', async () => {
    mockedDownloadUpdate.mockResolvedValue('explorie-updates/explorie-0.2.0.exe');
    useUpdateStore.setState({ updateInfo });

    await expect(useUpdateStore.getState().downloadNow()).resolves.toBe(
      'explorie-updates/explorie-0.2.0.exe'
    );

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'ready',
      updatePath: 'explorie-updates/explorie-0.2.0.exe',
      error: null,
    });

    await useUpdateStore.getState().installNow();

    expect(mockedInstallUpdate).toHaveBeenCalledWith('explorie-updates/explorie-0.2.0.exe');
    expect(useUpdateStore.getState().status).toBe('installing');
  });

  it('sets useful errors for missing download state and failed checks', async () => {
    await expect(useUpdateStore.getState().downloadNow()).resolves.toBeNull();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'error',
      error: 'No update information available.',
    });

    mockedCheckForUpdate.mockRejectedValue(new Error('network down'));
    await expect(useUpdateStore.getState().checkNow()).resolves.toBeNull();

    expect(useUpdateStore.getState()).toMatchObject({
      status: 'error',
      error: 'network down',
    });

    useUpdateStore.getState().clearError();
    expect(useUpdateStore.getState().error).toBeNull();
  });
});
