import { invoke, isTauri } from '@tauri-apps/api/core';
import { mkdir, writeFile } from '@tauri-apps/plugin-fs';

export type UpdateInfo = {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  downloadUrl: string;
  assetName?: string;
};

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
};

type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

const GITHUB_REPO = 'oshtz/explorie';
const UPDATE_DIR_NAME = 'explorie-updates';
const WINDOWS_ASSET_NAME = 'explorie-portable.exe';
const MAC_ASSET_NAME = 'explorie.app.zip';
const ALLOWED_UPDATE_HOSTS = new Set(['github.com']);
const RELEASE_PATH_PREFIX = `/${GITHUB_REPO}/releases/download/`;

export function isTauriRuntime(): boolean {
  return isTauri();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function downloadBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

function normalizeVersion(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, '');
}

function assertValidUpdateUrl(url: string, assetName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid update URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Update URL must use https.');
  }

  if (!ALLOWED_UPDATE_HOSTS.has(parsed.hostname)) {
    throw new Error('Update URL host is not allowed.');
  }

  if (!parsed.pathname.startsWith(RELEASE_PATH_PREFIX)) {
    throw new Error('Update URL must point to a release asset.');
  }

  try {
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath.endsWith(`/${assetName}`)) {
      throw new Error('Update URL does not match the release asset.');
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Update URL does not match the release asset.');
  }
}

function validateUpdateInfo(info: UpdateInfo): void {
  if (!info.downloadUrl || typeof info.downloadUrl !== 'string') {
    throw new Error('Update download URL is missing.');
  }
  if (!info.assetName || typeof info.assetName !== 'string') {
    throw new Error('Update asset name is missing.');
  }
  assertValidUpdateUrl(info.downloadUrl, info.assetName);
}

function parseVersion(value: string): number[] {
  const matches = value.match(/\d+/g);
  if (!matches) return [];
  return matches.map((part) => Number(part));
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const max = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < max; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function getPlatform(): Promise<Platform> {
  if (!isTauriRuntime()) return 'unknown';
  try {
    const os = await invoke<string>('get_platform');
    if (os === 'windows' || os === 'macos' || os === 'linux') return os;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function getCurrentVersion(): Promise<string> {
  if (!isTauriRuntime()) {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  }
  try {
    return await invoke<string>('get_app_version');
  } catch {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  }
}

async function getAssetConfig(): Promise<{ name: string; extension: string }> {
  const os = await getPlatform();
  if (os === 'macos') {
    return { name: MAC_ASSET_NAME, extension: '.app.zip' };
  }
  return { name: WINDOWS_ASSET_NAME, extension: '.exe' };
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauriRuntime() || import.meta.env.DEV) return null;

  const currentVersionRaw = await getCurrentVersion();
  const currentVersion = normalizeVersion(currentVersionRaw) || '0.0.0';

  const release = await fetchJson<GitHubRelease>(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  );

  const latestVersion = normalizeVersion(release.tag_name || '');
  if (!latestVersion) return null;

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return null;
  }

  const assetConfig = await getAssetConfig();
  const assets = release.assets ?? [];
  const asset =
    assets.find((entry) => entry.name === assetConfig.name) ??
    assets.find((entry) =>
      entry.browser_download_url.toLowerCase().endsWith(assetConfig.extension)
    );

  if (!asset) {
    throw new Error('No compatible update asset found for this platform.');
  }

  const updateInfo = {
    version: latestVersion,
    notes: release.body ?? null,
    publishedAt: release.published_at ?? null,
    downloadUrl: asset.browser_download_url,
    assetName: asset.name,
  };

  validateUpdateInfo(updateInfo);
  return updateInfo;
}

export async function downloadUpdate(update: UpdateInfo): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error('Updates require the Tauri runtime.');
  }

  validateUpdateInfo(update);

  const os = await getPlatform();
  const binary = await downloadBinary(update.downloadUrl);
  const { appLocalDataDir } = await import('@tauri-apps/api/path');

  // Get the app local data directory path
  const appLocalData = await appLocalDataDir();
  const updateDirPath = `${appLocalData}/${UPDATE_DIR_NAME}`;

  await mkdir(updateDirPath, { recursive: true });

  const fileName =
    os === 'macos' ? `explorie-${update.version}.app.zip` : `explorie-${update.version}.exe`;
  const fullPath = `${updateDirPath}/${fileName}`;
  const relativePath = `${UPDATE_DIR_NAME}/${fileName}`;

  await writeFile(fullPath, binary);

  if (os === 'macos') {
    const extractedPath = await invoke<string>('extract_app_zip', { zipPath: relativePath });
    return extractedPath;
  }

  return relativePath;
}

export async function installUpdate(updatePath: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error('Updates require the Tauri runtime.');
  }
  await invoke('apply_update', { updatePath });
}
