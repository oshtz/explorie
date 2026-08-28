import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const proofPath = path.join(process.cwd(), '.release-checks', 'platform-proof.json');
const required = {
  windows: [
    'installerInstalled',
    'headedConsoleAbsent',
    'multiWindowIsolation',
    'inboundDragDrop',
    'outboundDragDrop',
    'mixedDpiWindowRestore',
    'crashRestore',
    'folderIntegrationEnabled',
    'folderIntegrationDisabled',
    'folderIntegrationRestoredAfterUninstall',
    'disposableFilesystemOperations',
    'remoteDriveLifecycle',
  ],
  macos: [
    'dmgInstalledAndLaunched',
    'signatureValid',
    'notarizationValid',
    'gatekeeperAccepted',
    'multiWindowIsolation',
    'inboundDragDrop',
    'outboundDragDrop',
    'multiMonitorWindowRestore',
    'crashRestore',
    'folderIntegrationEnabled',
    'folderIntegrationDisabled',
    'disposableFilesystemOperations',
  ],
};

async function packageVersion() {
  return JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')).version;
}

async function initialize() {
  const checks = (platform) => Object.fromEntries(required[platform].map((name) => [name, false]));
  const proof = {
    version: await packageVersion(),
    candidateTag: '',
    windows: { artifact: '', sha256: '', machine: '', testedAt: '', checks: checks('windows') },
    macos: { artifact: '', sha256: '', machine: '', testedAt: '', checks: checks('macos') },
    notes: '',
  };
  await mkdir(path.dirname(proofPath), { recursive: true });
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
  console.log(proofPath);
}

function validatePlatform(proof, platform, errors) {
  const candidate = proof[platform];
  if (!candidate || typeof candidate !== 'object') {
    errors.push(`${platform}: proof section is missing`);
    return;
  }
  for (const field of ['artifact', 'machine', 'testedAt']) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
      errors.push(`${platform}: ${field} is required`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(candidate.sha256 ?? '')) {
    errors.push(`${platform}: sha256 must be the tested artifact's 64-character digest`);
  }
  for (const check of required[platform]) {
    if (candidate.checks?.[check] !== true) {
      errors.push(`${platform}: ${check} was not attested`);
    }
  }
}

async function verify() {
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  const version = await packageVersion();
  const errors = [];
  if (proof.version !== version) errors.push(`version: expected ${version}, got ${proof.version}`);
  if (proof.candidateTag !== `v${version}`) {
    errors.push(`candidateTag: expected v${version}, got ${proof.candidateTag || '(empty)'}`);
  }
  validatePlatform(proof, 'windows', errors);
  validatePlatform(proof, 'macos', errors);
  if (errors.length > 0) {
    throw new Error(`Platform proof is incomplete:\n- ${errors.join('\n- ')}`);
  }
  console.log(`Platform proof is complete for v${version}.`);
}

const command = process.argv[2];
if (command === 'init') {
  await initialize();
} else if (command === 'verify') {
  await verify();
} else {
  throw new Error('Usage: node scripts/platform-proof.mjs <init|verify>');
}
