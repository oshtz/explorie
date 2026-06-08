import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdate,
  downloadUpdate,
  getCurrentVersion,
  installUpdate,
  isTauriRuntime,
  type UpdateInfo,
} from './updater';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appLocalDataDir: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: mocks.appLocalDataDir,
}));

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function binaryResponse(bytes: number[], status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    arrayBuffer: vi.fn(async () => new Uint8Array(bytes).buffer),
  } as unknown as Response;
}

const windowsUpdate: UpdateInfo = {
  version: '0.2.0',
  notes: 'Release notes',
  publishedAt: '2026-06-03T00:00:00Z',
  downloadUrl: 'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
  assetName: 'explorie-portable.exe',
};

describe('updater service', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    vi.stubGlobal('fetch', vi.fn());
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset();
    mocks.mkdir.mockReset();
    mocks.writeFile.mockReset();
    mocks.appLocalDataDir.mockReset();

    mocks.isTauri.mockReturnValue(true);
    mocks.appLocalDataDir.mockResolvedValue('/user/appdata');
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_app_version') return Promise.resolve('0.1.0');
      if (command === 'get_platform') return Promise.resolve('windows');
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports whether the app is running inside Tauri', () => {
    mocks.isTauri.mockReturnValueOnce(false).mockReturnValueOnce(true);

    expect(isTauriRuntime()).toBe(false);
    expect(isTauriRuntime()).toBe(true);
  });

  it('loads current version from Tauri and falls back outside Tauri or on command errors', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(getCurrentVersion()).resolves.toBe('0.0.0');

    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValueOnce('0.3.0');
    await expect(getCurrentVersion()).resolves.toBe('0.3.0');

    mocks.invoke.mockRejectedValueOnce(new Error('version unavailable'));
    await expect(getCurrentVersion()).resolves.toBe('0.0.0');
  });

  it('returns null when update checks run outside Tauri or in dev mode', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(checkForUpdate()).resolves.toBeNull();

    mocks.isTauri.mockReturnValue(true);
    vi.stubEnv('DEV', true);
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it('finds the latest compatible Windows release asset', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.2.0',
        body: 'Release notes',
        published_at: '2026-06-03T00:00:00Z',
        assets: [
          {
            name: 'explorie.app.zip',
            browser_download_url:
              'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie.app.zip',
          },
          {
            name: 'explorie-portable.exe',
            browser_download_url:
              'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
          },
        ],
      })
    );

    await expect(checkForUpdate()).resolves.toEqual(windowsUpdate);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/oshtz/explorie/releases/latest',
      {
        headers: { Accept: 'application/vnd.github+json' },
      }
    );
  });

  it('returns null for current releases and rejects missing or untrusted assets', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.1.0',
        assets: [],
      })
    );
    await expect(checkForUpdate()).resolves.toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.2.0',
        assets: [],
      })
    );
    await expect(checkForUpdate()).rejects.toThrow('No compatible update asset found');

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.2.0',
        assets: [
          {
            name: 'explorie-portable.exe',
            browser_download_url:
              'http://github.com/oshtz/explorie/releases/download/v0.2.0/explorie-portable.exe',
          },
        ],
      })
    );
    await expect(checkForUpdate()).rejects.toThrow('Update URL must use https');
  });

  it('uses macOS asset names and extension fallback when checking releases', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_app_version') return Promise.resolve('0.1.0');
      if (command === 'get_platform') return Promise.resolve('macos');
      return Promise.resolve(undefined);
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        tag_name: 'v0.2.0',
        assets: [
          {
            name: 'Explorie-mac-release.app.zip',
            browser_download_url:
              'https://github.com/oshtz/explorie/releases/download/v0.2.0/Explorie-mac-release.app.zip',
          },
        ],
      })
    );

    await expect(checkForUpdate()).resolves.toMatchObject({
      version: '0.2.0',
      assetName: 'Explorie-mac-release.app.zip',
    });
  });

  it('downloads Windows updates into app local data and returns the relative path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(binaryResponse([1, 2, 3]));

    await expect(downloadUpdate(windowsUpdate)).resolves.toBe(
      'explorie-updates/explorie-0.2.0.exe'
    );

    expect(mocks.mkdir).toHaveBeenCalledWith('/user/appdata/explorie-updates', {
      recursive: true,
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/user/appdata/explorie-updates/explorie-0.2.0.exe',
      new Uint8Array([1, 2, 3])
    );
  });

  it('extracts downloaded macOS zip updates', async () => {
    const macUpdate: UpdateInfo = {
      version: '0.2.0',
      notes: null,
      publishedAt: null,
      downloadUrl: 'https://github.com/oshtz/explorie/releases/download/v0.2.0/explorie.app.zip',
      assetName: 'explorie.app.zip',
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_platform') return Promise.resolve('macos');
      if (command === 'extract_app_zip') return Promise.resolve('/Applications/explorie.app');
      return Promise.resolve(undefined);
    });
    vi.mocked(fetch).mockResolvedValueOnce(binaryResponse([4, 5, 6]));

    await expect(downloadUpdate(macUpdate)).resolves.toBe('/Applications/explorie.app');

    expect(mocks.writeFile).toHaveBeenCalledWith(
      '/user/appdata/explorie-updates/explorie-0.2.0.app.zip',
      new Uint8Array([4, 5, 6])
    );
    expect(mocks.invoke).toHaveBeenCalledWith('extract_app_zip', {
      zipPath: 'explorie-updates/explorie-0.2.0.app.zip',
    });
  });

  it('rejects downloads outside Tauri, failed responses, and invalid update URLs', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(downloadUpdate(windowsUpdate)).rejects.toThrow(
      'Updates require the Tauri runtime'
    );

    mocks.isTauri.mockReturnValue(true);
    await expect(
      downloadUpdate({
        ...windowsUpdate,
        downloadUrl: 'https://example.com/not-allowed.exe',
      })
    ).rejects.toThrow('Update URL host is not allowed');

    vi.mocked(fetch).mockResolvedValueOnce(binaryResponse([], 500, 'Server Error'));
    await expect(downloadUpdate(windowsUpdate)).rejects.toThrow(
      'Download failed: 500 Server Error'
    );
  });

  it('delegates update installation to Tauri', async () => {
    await installUpdate('explorie-updates/explorie-0.2.0.exe');

    expect(mocks.invoke).toHaveBeenCalledWith('apply_update', {
      updatePath: 'explorie-updates/explorie-0.2.0.exe',
    });

    mocks.isTauri.mockReturnValue(false);
    await expect(installUpdate('path')).rejects.toThrow('Updates require the Tauri runtime');
  });
});
