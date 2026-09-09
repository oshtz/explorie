import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyReleaseAssets(release, directory, repository, tag, attestations) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) {
    throw new Error('Invalid repository or release tag');
  }
  if (release.tag_name !== tag || release.draft !== true || release.prerelease !== false) {
    throw new Error('Expected the exact draft release');
  }
  const names = {
    windows: `explorie-${tag.slice(1)}-windows-x64-setup-unsigned.exe`,
    macos: `explorie-${tag.slice(1)}-macos-arm64.dmg`,
  };
  if (!Array.isArray(release.assets) || release.assets.length !== 2) {
    throw new Error('Release must contain exactly the two installers');
  }
  for (const [platform, name] of Object.entries(names)) {
    const matches = release.assets.filter(asset => asset.name === name);
    if (matches.length !== 1) throw new Error(`Missing or duplicate ${platform} installer`);
    const asset = matches[0];
    if (asset.state !== 'uploaded'
        || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${tag}/${name}`
        || !Number.isSafeInteger(asset.size) || asset.size <= 0
        || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`Invalid ${platform} asset metadata or SHA-256 digest`);
    }
    const filename = path.join(directory, name);
    const file = await stat(filename);
    if (!file.isFile() || file.size !== asset.size) throw new Error(`${platform} installer size mismatch`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const actual = hash.digest('hex');
    if (`sha256:${actual}` !== asset.digest) throw new Error(`${platform} installer SHA-256 mismatch`);
    if (attestations) {
      const expected = attestations[platform];
      if (!/^[a-f0-9]{64}$/i.test(expected ?? '') || actual !== expected.toLowerCase()) {
        throw new Error(`${platform} draft asset is not the real-machine-tested artifact`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [metadata, directory, repository, tag, mode] = process.argv.slice(2);
  if (!tag || (mode && mode !== '--attested')) throw new Error('Expected metadata, directory, repository, tag and optional --attested');
  await verifyReleaseAssets(JSON.parse(await readFile(metadata, 'utf8')), directory, repository, tag,
    mode === '--attested' ? {
      windows: process.env.WINDOWS_ATTESTED_SHA256,
      macos: process.env.MACOS_ATTESTED_SHA256,
    } : undefined);
  console.log('Verified both installer assets and their SHA-256 digests');
}
