import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReleaseAssets } from './verify-release-assets.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'explorie-release-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = 'bildhaus/explorie', tag = 'v0.1.0';
  const release = { tag_name: tag, draft: true, prerelease: false, assets: [] };
  const attestations = {};
  for (const [platform, suffix] of Object.entries({ windows: 'windows-x64-setup-unsigned.exe', macos: 'macos-arm64.dmg' })) {
    const name = `explorie-0.1.0-${suffix}`;
    const bytes = Buffer.from(`${platform} verified installer`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    attestations[platform] = hash;
    await writeFile(path.join(directory, name), bytes);
    release.assets.push({ name, state: 'uploaded', size: bytes.length, digest: `sha256:${hash}`,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` });
  }
  return { release, directory, repository, tag, attestations };
}

test('verifies exactly two installers against GitHub digests and human attestations', async t => {
  const f = await fixture(t);
  await verifyReleaseAssets(f.release, f.directory, f.repository, f.tag);
  await verifyReleaseAssets(f.release, f.directory, f.repository, f.tag, f.attestations);
});

test('rejects missing, duplicate, extra and foreign platform assets', async t => {
  const f = await fixture(t);
  for (const assets of [[], [f.release.assets[0]], [...f.release.assets, { name: 'SHA256SUMS.txt' }],
    [f.release.assets[0], f.release.assets[0]], [f.release.assets[0], { ...f.release.assets[1], name: 'portable.zip' }]]) {
    await assert.rejects(verifyReleaseAssets({ ...f.release, assets }, f.directory, f.repository, f.tag));
  }
});

test('rejects wrong release identity or a release already published', async t => {
  const f = await fixture(t);
  for (const patch of [{ tag_name: 'v0.1.1' }, { draft: false }, { prerelease: true }]) {
    await assert.rejects(verifyReleaseAssets({ ...f.release, ...patch }, f.directory, f.repository, f.tag), /exact draft/);
  }
});

test('fails closed on malformed digest, wrong URL, size or upload state', async t => {
  const f = await fixture(t);
  for (const patch of [{ digest: null }, { digest: '' }, { digest: `sha512:${'a'.repeat(64)}` },
    { digest: `sha256:${'g'.repeat(64)}` }, { digest: 'sha256:abc' }, { state: 'starter' },
    { size: 0 }, { size: 0.5 }, { size: f.release.assets[0].size + 1 },
    { browser_download_url: f.release.assets[0].browser_download_url.replace('github.com', 'example.com') }]) {
    const release = { ...f.release, assets: [{ ...f.release.assets[0], ...patch }, f.release.assets[1]] };
    await assert.rejects(verifyReleaseAssets(release, f.directory, f.repository, f.tag));
  }
});

test('rejects changed bytes even when installer length is unchanged', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, f.release.assets[0].name), Buffer.alloc(f.release.assets[0].size));
  await assert.rejects(verifyReleaseAssets(f.release, f.directory, f.repository, f.tag), /SHA-256 mismatch/);
});

test('publication requires both exact tested hashes', async t => {
  const f = await fixture(t);
  for (const proof of [{}, { windows: f.attestations.windows },
    { ...f.attestations, macos: 'b'.repeat(64) }, { ...f.attestations, windows: 'bad' }]) {
    await assert.rejects(verifyReleaseAssets(f.release, f.directory, f.repository, f.tag, proof), /real-machine-tested/);
  }
});
