import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createZip, nativeTarget, packagePlugins, PLUGINS, TARGETS, validateManifest, verifyCatalog } from './package-plugins.mjs';

function manifest(id) {
  return { id, name: id, version: '0.2.15', protocolVersion: 1, description: 'Fixture',
    capabilities: ['Read folders'], dependencies: [], settings: [], executables: {
      [TARGETS[0]]: `explorie-plugin-${id}.exe`, [TARGETS[1]]: `explorie-plugin-${id}`,
    } };
}

async function fixture(t, target) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'explorie-plugin-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.15' }));
  const binaryDirectory = path.join(root, 'binaries');
  await mkdir(binaryDirectory);
  for (const id of PLUGINS) {
    await mkdir(path.join(root, 'plugins', id), { recursive: true });
    await writeFile(path.join(root, 'plugins', id, 'plugin.json'), JSON.stringify(manifest(id)));
    await writeFile(path.join(binaryDirectory, manifest(id).executables[target]), Buffer.from(`signed fixture ${id}\0\xff`, 'latin1'));
  }
  return { root, target, binaryDirectory, build: false };
}

// Independently walk ZIP central-directory/local records to verify the writer's layout.
function entries(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let cursor = bytes.readUInt32LE(end + 16);
  return Array.from({ length: bytes.readUInt16LE(end + 10) }, () => {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const start = bytes.readUInt32LE(cursor + 42);
    const length = bytes.readUInt32LE(cursor + 24);
    assert.equal(bytes.readUInt32LE(start), 0x04034b50);
    assert.equal(bytes.readUInt16LE(start + 8), 0); // Stored bytes, never rewritten.
    assert.equal(bytes.readUInt32LE(start + 22), length);
    assert.equal(bytes.readUInt32LE(start + 14), bytes.readUInt32LE(cursor + 16));
    const contentStart = start + 30 + bytes.readUInt16LE(start + 26);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    cursor += 46 + nameLength;
    return { name, mode, bytes: bytes.subarray(contentStart, contentStart + length) };
  });
}

for (const target of TARGETS) test(`packages exact manifests and executable bytes for ${target}`, async t => {
  const options = await fixture(t, target);
  const catalogPath = await packagePlugins(options);
  const catalog = await verifyCatalog(catalogPath, target, '0.2.15');
  assert.deepEqual(catalog.map(entry => entry.manifest.id), PLUGINS);
  for (const entry of catalog) {
    const filename = new URL(entry.assetUrl).pathname.split('/').at(-1);
    const archive = await readFile(path.join(path.dirname(catalogPath), filename));
    assert.equal(createHash('sha256').update(archive).digest('hex'), entry.sha256);
    const content = entries(archive);
    assert.deepEqual(content.map(item => item.name), ['plugin.json', entry.manifest.executables[target]]);
    assert.deepEqual(JSON.parse(content[0].bytes), entry.manifest);
    assert.equal(content[1].mode, 0o100755);
    assert.deepEqual(content[1].bytes, await readFile(path.join(options.binaryDirectory, content[1].name)));
  }
  const checksum = await readFile(path.join(path.dirname(catalogPath), `SHA256SUMS-plugins-${target}.txt`), 'utf8');
  assert.equal(checksum.trim().split('\n').length, 4);
  await packagePlugins(options);
  assert.equal(await readFile(catalogPath, 'utf8'), `${JSON.stringify(catalog, null, 2)}\n`);
});

test('missing inputs preserve previous catalog; tampered archives fail verification', async t => {
  const options = await fixture(t, TARGETS[0]);
  const catalog = await packagePlugins(options);
  const original = await readFile(catalog);
  await rm(path.join(options.binaryDirectory, 'explorie-plugin-git.exe'));
  await assert.rejects(packagePlugins(options));
  assert.deepEqual(await readFile(catalog), original);
  const entry = JSON.parse(original)[0];
  const archive = path.join(path.dirname(catalog), new URL(entry.assetUrl).pathname.split('/').at(-1));
  await writeFile(archive, 'corrupt');
  await assert.rejects(verifyCatalog(catalog, TARGETS[0], '0.2.15'), /integrity failed/);
});

test('rejects incompatible manifests, unsafe paths and unsupported platforms', () => {
  assert.throws(() => validateManifest({ ...manifest('git'), protocolVersion: 2 }, 'git', '0.2.15', TARGETS[0]), /Incompatible/);
  assert.throws(() => validateManifest(manifest('git'), 'git', '0.2.16', TARGETS[0]), /Incompatible/);
  assert.throws(() => validateManifest({ ...manifest('git'), executables: { [TARGETS[0]]: '../bad.exe' } }, 'git', '0.2.15', TARGETS[0]), /Invalid executable/);
  for (const name of ['../bad', 'x/y', 'x\\y', 'C:evil', '..']) {
    assert.throws(() => createZip([{ name, bytes: Buffer.from('bad') }]), /Unsafe/);
  }
  assert.equal(nativeTarget('win32', 'x64'), TARGETS[0]);
  assert.equal(nativeTarget('darwin', 'arm64'), TARGETS[1]);
  assert.throws(() => nativeTarget('linux', 'x64'), /No official/);
});

test('release order preserves signing, notarization, catalogs and publication gates', async () => {
  const workflow = await readFile('.github/workflows/build-release.yml', 'utf8');
  assert.ok(workflow.indexOf('Build and package official Windows plugins') < workflow.indexOf('Build GPUI Windows application'));
  const mac = workflow.slice(workflow.indexOf('Build, sign, and notarize official macOS plugins'));
  assert.ok(mac.indexOf('codesign --force') < mac.indexOf('package-plugins.mjs --target'));
  assert.ok(mac.indexOf('notarytool submit') < mac.indexOf('Build GPUI macOS app and DMG'));
  assert.match(mac, /status!=="Accepted"/);
  assert.match(mac, /spctl --assess --type execute/);
  assert.equal((workflow.match(/sha256sum --check "SHA256SUMS-plugins-\$target.txt"/g) ?? []).length, 2);
  assert.match(workflow, /needs: \[validate, build-windows, build-macos\]/);
  assert.match(workflow, /environment: release-publish/);
  assert.match(workflow, /WINDOWS_ATTESTED_SHA256/);
  assert.match(workflow, /macos_real_machine_verified == true/);
  const build = await readFile('apps/desktop/gpui/build.rs', 'utf8');
  assert.match(build, /EXPLORIE_PLUGIN_CATALOG/);
  assert.match(build, /output.join\("plugin-catalog.json"\)/);
});
