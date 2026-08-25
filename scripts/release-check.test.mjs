import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as releaseCheck from './release-check.mjs';
import { RCLONE_TARGETS, RCLONE_VERSION, nativeTarget } from './prepare-rclone.mjs';
import { WINFSP_INSTALLER, WINFSP_SHA256, WINFSP_VERSION } from './prepare-winfsp.mjs';

const {
  DEFAULT_COMMANDS,
  createSpawnInvocation,
  createReleaseReport,
  getExpectedArtifacts,
  renderMarkdownReport,
  runCommand,
  runReleaseCheck,
  tailText,
  validateReleaseContext,
  verifyExpectedArtifacts,
  writeReleaseReports,
} = releaseCheck;

const expectedDisplays = [
  'pnpm install --frozen-lockfile --ignore-scripts',
  'pnpm prepare:native',
  'cargo metadata --locked --format-version 1',
  'cargo fmt --all -- --check',
  'cargo test --workspace --no-fail-fast',
  'cargo clippy --workspace --all-targets --all-features -- -D warnings',
  'cargo audit',
  'corepack pnpm@11.13.0 audit --audit-level=moderate',
  'cargo build -p explorie-gpui --release --locked',
  'git diff --check',
];

const fixedDate = new Date('2026-06-06T19:30:45.000Z');

test('rclone sidecars are pinned for every packaged desktop target', () => {
  assert.equal(RCLONE_VERSION, 'v1.74.4');
  assert.equal(nativeTarget('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(nativeTarget('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.deepEqual(Object.keys(RCLONE_TARGETS).sort(), [
    'aarch64-apple-darwin',
    'aarch64-pc-windows-msvc',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ]);
  for (const asset of Object.values(RCLONE_TARGETS)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test('WinFsp installer is pinned for on-demand Windows remote drives', () => {
  assert.equal(WINFSP_VERSION, '2.1.25156');
  assert.equal(WINFSP_INSTALLER, 'winfsp-2.1.25156.msi');
  assert.match(WINFSP_SHA256, /^[0-9a-f]{64}$/);
});

test('root desktop commands make GPUI the only executable desktop authority', async () => {
  const rootPackage = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));

  assert.equal(rootPackage.scripts['desktop:dev'], 'cargo run -p explorie-gpui');
  assert.equal(
    rootPackage.scripts['desktop:build'],
    'cargo build -p explorie-gpui --release --locked'
  );
  assert.equal(
    rootPackage.scripts['desktop:smoke:release:windows'],
    'pwsh -NoProfile -File scripts/smoke-gpui-release.ps1'
  );
  assert.equal(rootPackage.scripts['desktop:legacy:dev'], undefined);
  assert.equal(rootPackage.scripts['desktop:legacy:build'], undefined);
  assert.equal(rootPackage.devDependencies['@tauri-apps/cli'], undefined);
  assert.equal(rootPackage.devDependencies['@playwright/test'], undefined);

  const nodeLock = await readFile(path.join(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(nodeLock, /@tauri-apps|playwright|react|vite|vitest/);

  for (const removedPath of [
    'pnpm-workspace.yaml',
    'playwright.config.ts',
    'tests/e2e.spec.ts',
    'eslint.config.mjs',
    'apps/desktop/frontend/package.json',
  ]) {
    await assert.rejects(readFile(path.join(process.cwd(), removedPath), 'utf8'), {
      code: 'ENOENT',
    });
  }
});

test('packaged native assets have a Tauri-independent authority', async () => {
  const sources = await Promise.all(
    [
      'scripts/prepare-rclone.mjs',
      'scripts/prepare-winfsp.mjs',
      'crates/native-services/build.rs',
      'apps/desktop/gpui/explorie.rc',
      'scripts/package-gpui-macos.sh',
    ].map((relativePath) => readFile(path.join(process.cwd(), relativePath), 'utf8'))
  );

  for (const source of sources) {
    assert.match(source, /native-assets/);
    assert.doesNotMatch(source, /frontend[\\/]src-tauri[\\/](?:binaries|resources|icons|macos)/);
  }
});

function sampleContext() {
  return {
    generatedAt: fixedDate.toISOString(),
    releaseTag: null,
    rootPackageVersion: '0.1.0',
    gpuiPackageVersion: '0.1.0',
    branch: 'codex/release-confidence-pack',
    shortCommit: 'abc1234',
    dirtyBefore: false,
    dirtyAfter: false,
    os: 'win32',
    arch: 'x64',
    nodeVersion: 'v22.14.1',
    cpuCount: 8,
    toolVersions: {
      pnpm: '9.0.0',
      rustc: 'rustc 1.87.0',
      cargo: 'cargo 1.87.0',
    },
    expectedArtifacts: ['target/release/explorie-gpui.exe'],
  };
}

test('DEFAULT_COMMANDS preserves exact display order and representative execution specs', () => {
  assert.deepEqual(
    DEFAULT_COMMANDS.map((command) => command.display),
    expectedDisplays
  );

  assert.equal(DEFAULT_COMMANDS[1].command, 'pnpm');
  assert.deepEqual(DEFAULT_COMMANDS[1].args, ['prepare:native']);
  assert.equal(DEFAULT_COMMANDS[4].command, 'cargo');
  assert.deepEqual(DEFAULT_COMMANDS[4].args, ['test', '--workspace', '--no-fail-fast']);
  assert.equal(DEFAULT_COMMANDS[5].command, 'cargo');
  assert.deepEqual(DEFAULT_COMMANDS[5].args, [
    'clippy',
    '--workspace',
    '--all-targets',
    '--all-features',
    '--',
    '-D',
    'warnings',
  ]);
  assert.equal(DEFAULT_COMMANDS[8].command, 'cargo');
  assert.deepEqual(DEFAULT_COMMANDS[8].args, [
    'build',
    '-p',
    'explorie-gpui',
    '--release',
    '--locked',
  ]);
  assert.equal(DEFAULT_COMMANDS[9].command, 'git');
  assert.deepEqual(DEFAULT_COMMANDS[9].args, ['diff', '--check']);
});

test('getExpectedArtifacts uses the native GPUI desktop artifact', () => {
  assert.deepEqual(getExpectedArtifacts('win32'), ['target/release/explorie-gpui.exe']);
  assert.deepEqual(getExpectedArtifacts('darwin'), ['target/release/explorie-gpui']);
  assert.deepEqual(getExpectedArtifacts('linux'), ['target/release/explorie-gpui']);
});

test('validateReleaseContext requires a clean, version-aligned source and matching tag', () => {
  assert.deepEqual(validateReleaseContext(sampleContext(), { tag: 'v0.1.0' }), []);
  assert.deepEqual(validateReleaseContext(sampleContext(), { tag: 'release-0.1.0' }), [
    'Release tag release-0.1.0 is not a supported v* semantic version.',
  ]);

  assert.deepEqual(
    validateReleaseContext(
      {
        ...sampleContext(),
        dirtyBefore: true,
        gpuiPackageVersion: '0.2.0',
      },
      { tag: 'v0.3.0' }
    ),
    [
      'Working tree is dirty.',
      'Version mismatch: 0.1.0, 0.2.0.',
      'Release tag v0.3.0 does not match package version v0.1.0.',
    ]
  );
});

test('verifyExpectedArtifacts checks the actual workspace target path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-artifact-test-'));
  const artifact = path.join(directory, 'target', 'release', 'explorie-gpui.exe');

  try {
    assert.deepEqual(await verifyExpectedArtifacts({ rootDir: directory, platform: 'win32' }), [
      'Release artifact is missing: target/release/explorie-gpui.exe',
    ]);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, 'binary');
    assert.deepEqual(await verifyExpectedArtifacts({ rootDir: directory, platform: 'win32' }), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('createSpawnInvocation shells pnpm on Windows only', () => {
  assert.equal(typeof releaseCheck.createSpawnInvocation, 'function');
  assert.deepEqual(createSpawnInvocation('pnpm', ['--version'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm', '--version'],
  });
  assert.deepEqual(createSpawnInvocation('corepack', ['pnpm@11.13.0', '--version'], 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'corepack', 'pnpm@11.13.0', '--version'],
  });
  assert.deepEqual(createSpawnInvocation('pnpm', ['--version'], 'linux'), {
    command: 'pnpm',
    args: ['--version'],
  });
  assert.deepEqual(createSpawnInvocation('cargo', ['--version'], 'win32'), {
    command: 'cargo',
    args: ['--version'],
  });
});

test('tailText keeps the newest lines', () => {
  assert.equal(tailText('one\ntwo\nthree\nfour', 2), 'three\nfour');
});

test('renderMarkdownReport includes status, branch, expected artifacts, and command display', () => {
  const report = createReleaseReport({
    context: sampleContext(),
    commands: [
      {
        display: expectedDisplays[0],
        exitCode: 0,
        elapsedMs: 123,
        outputTail: 'ok',
      },
    ],
  });

  const markdown = renderMarkdownReport(report);

  assert.match(markdown, /Status: pass/);
  assert.match(markdown, /Branch: codex\/release-confidence-pack/);
  assert.match(markdown, /target\/release\/explorie-gpui\.exe/);
  assert.match(markdown, /pnpm install --frozen-lockfile --ignore-scripts/);
});

test('runCommand executes a real command and captures output', async () => {
  const result = await runCommand({
    display: 'node --version',
    command: process.execPath,
    args: ['--version'],
  });

  assert.equal(result.display, 'node --version');
  assert.equal(result.exitCode, 0);
  assert.match(result.outputTail, /^v\d+\.\d+\.\d+/);
  assert.equal(typeof result.elapsedMs, 'number');
});

test('runCommand merges command-specific environment overrides', async () => {
  const result = await runCommand({
    display: 'node env override',
    command: process.execPath,
    args: ['-e', 'console.log(process.env.EXPLORIE_RELEASE_CHECK_ENV_TEST)'],
    env: {
      EXPLORIE_RELEASE_CHECK_ENV_TEST: 'isolated',
    },
  });

  assert.equal(result.display, 'node env override');
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTail.trim(), 'isolated');
});

test(
  'runCommand executes pnpm through the Windows shell on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const result = await runCommand({
      display: 'pnpm --version',
      command: 'pnpm',
      args: ['--version'],
    });

    assert.equal(result.display, 'pnpm --version');
    assert.equal(result.exitCode, 0);
    assert.match(result.outputTail.trim(), /^\d+\.\d+\.\d+/);
  }
);

test('failed reports set fail status and failedCommand', () => {
  const failedCommand = {
    display: expectedDisplays[1],
    exitCode: 1,
    elapsedMs: 250,
    outputTail: 'lint failed',
  };

  const report = createReleaseReport({
    context: sampleContext(),
    commands: [
      {
        display: expectedDisplays[0],
        exitCode: 0,
        elapsedMs: 100,
        outputTail: 'ok',
      },
      failedCommand,
    ],
  });

  assert.equal(report.status, 'fail');
  assert.deepEqual(report.failedCommand, failedCommand);
});

test('runReleaseCheck stops after first failure while returning partial report', async () => {
  const calls = [];
  const commands = [
    { display: 'first', command: 'first', args: [] },
    { display: 'second', command: 'second', args: [] },
    { display: 'third', command: 'third', args: [] },
  ];

  const report = await runReleaseCheck({
    commands,
    collectContext: async () => sampleContext(),
    commandRunner: async (command) => {
      calls.push(command.display);
      return {
        display: command.display,
        exitCode: command.display === 'second' ? 1 : 0,
        elapsedMs: 10,
        outputTail: `${command.display} output`,
      };
    },
    artifactVerifier: async () => [],
    writeReports: async (partialReport) => ({
      jsonPath: path.join('reports', 'release-check.json'),
      markdownPath: path.join('reports', 'release-check.md'),
      latestJsonPath: path.join('reports', 'latest.json'),
      latestMarkdownPath: path.join('reports', 'latest.md'),
      report: partialReport,
    }),
  });

  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(report.status, 'fail');
  assert.equal(report.commands.length, 3);
  assert.equal(report.failedCommand.display, 'second');
});

test('runReleaseCheck stops before commands when release prerequisites fail', async () => {
  let commandRan = false;
  const report = await runReleaseCheck({
    commands: [{ display: 'must not run', command: 'nope' }],
    collectContext: async () => ({ ...sampleContext(), dirtyBefore: true }),
    commandRunner: async () => {
      commandRan = true;
    },
    writeReports: async () => ({}),
  });

  assert.equal(commandRan, false);
  assert.equal(report.status, 'fail');
  assert.equal(report.failedCommand.display, 'release prerequisites');
});

test('workflows block audits and publish the exact attested draft assets', async () => {
  const [ci, release, mountDaemon, macosPackage] = await Promise.all([
    readFile(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(process.cwd(), '.github/workflows/build-release.yml'), 'utf8'),
    readFile(path.join(process.cwd(), 'apps/desktop/native-assets/macos/MountDaemon.m'), 'utf8'),
    readFile(path.join(process.cwd(), 'scripts/package-gpui-macos.sh'), 'utf8'),
  ]);

  assert.doesNotMatch(ci, /playwright|vite|explorie-desktop|test-frontend|test-e2e/i);
  assert.doesNotMatch(ci, /audit[^\n]*\|\| true/);
  assert.match(ci, /corepack pnpm@11\.13\.0 audit --audit-level=moderate/);
  assert.match(ci, /name: Security Audit[\s\S]*?node-version: '24'/);
  assert.match(ci, /name: Rust Tests & Coverage[\s\S]*?runs-on: windows-latest/);
  assert.match(
    ci,
    /Build GPUI Windows release[\s\S]*?cargo build -p explorie-gpui --release --locked/
  );
  assert.match(ci, /Smoke test GPUI Windows release[\s\S]*?scripts\/smoke-gpui-release\.ps1/);
  assert.match(ci, /name: macOS GPUI Tests & Build[\s\S]*?runs-on: macos-latest/);
  assert.match(
    ci,
    /Build GPUI macOS application[\s\S]*?cargo build -p explorie-gpui --release --locked/
  );
  assert.doesNotMatch(ci, /tauri build/);
  assert.match(ci, /name: Native Lint & Release Contracts[\s\S]*?runs-on: windows-latest/);
  assert.equal((ci.match(/name: Prepare native dependencies/g) ?? []).length, 2);
  assert.doesNotMatch(ci, /rclone-x86_64-unknown-linux-gnu/);
  assert.match(release, /gh release create/);
  assert.match(release, /run: pnpm release:check/);
  assert.match(release, /name: Validate release source[\s\S]*?runs-on: windows-latest/);
  assert.match(release, /name: Validate release source[\s\S]*?node-version: '24'/);
  assert.match(
    release,
    /Build GPUI Windows application[\s\S]*?cargo build -p explorie-gpui --release --locked/
  );
  assert.match(
    release,
    /native-assets\/binaries\/rclone-x86_64-pc-windows-msvc\.exe" -Destination "target\/release\/rclone\.exe"/
  );
  assert.doesNotMatch(release, /tauri build --no-bundle/);
  assert.match(
    release,
    /Build GPUI macOS app and DMG[\s\S]*?cargo build -p explorie-gpui --release --locked --target aarch64-apple-darwin[\s\S]*?scripts\/package-gpui-macos\.sh/
  );
  assert.doesNotMatch(release, /tauri build/);
  assert.match(
    release,
    /name: Notarize and staple macOS DMG[\s\S]*?xcrun notarytool submit[\s\S]*?--wait[\s\S]*?xcrun stapler staple/
  );
  assert.match(release, /Restore Enigma Virtual Box installer cache/);
  assert.match(release, /Install Enigma Virtual Box/);
  assert.match(release, /@insco\/enigma-virtualbox@1\.3\.4/);
  assert.doesNotMatch(release, /WebView2Loader\.dll/);
  assert.match(release, /--evbOptions\.deleteExtractedOnExit False/);
  assert.match(release, /--evbOptions\.shareVirtualSystem False/);
  assert.match(release, /--evbOptions\.allowRunningOfVirtualExeFiles True/);
  assert.match(release, /rclone\\\.exe[\s\S]*?Failed to set the rclone extraction action/);
  assert.match(
    release,
    /Copy-Item -LiteralPath \$rclone -Destination "\$staging\/rclone\.exe"[\s\S]*?\$staging\/installers\/winfsp-2\.1\.25156\.msi/
  );
  assert.match(release, /Smoke test Windows portable executable/);
  assert.match(release, /scripts\/smoke-gpui-release\.ps1 -Executable \$portable\[0\]\.FullName/);
  assert.match(release, /& \$rclone version[\s\S]*?Unexpected extracted rclone version/);
  assert.doesNotMatch(release, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS|tauri\.localhost/);
  assert.doesNotMatch(release, /Build NSIS installer|--bundles nsis|Smoke test Windows installer/);
  assert.match(release, /Smoke test macOS DMG/);
  assert.match(
    release,
    /name: Verify and stage macOS package[\s\S]*?hdiutil attach "\$\{dmgs\[0\]\}"[\s\S]*?app="\$\{apps\[0\]\}"/
  );
  assert.match(
    release,
    /Notarize and staple macOS DMG[\s\S]*?app="target\/release\/bundle\/macos\/explorie\.app"[\s\S]*?notarytool submit "\$app_zip"[\s\S]*?stapler staple "\$app"/
  );
  assert.doesNotMatch(release, /node scripts\/release-check\.mjs --preflight/);
  assert.match(release, /--draft/);
  assert.match(release, /gh release download/);
  assert.match(release, /gh release edit .*--draft=false --latest/);
  assert.match(release, /github\.event_name == 'workflow_dispatch'/);
  assert.match(release, /inputs\.publish == true/);
  assert.match(release, /inputs\.windows_real_machine_verified == true/);
  assert.match(release, /inputs\.macos_real_machine_verified == true/);
  assert.match(release, /if: github\.ref_type == 'tag'/);
  assert.match(release, /Release .* already exists; refusing to replace it/);
  assert.match(release, /must exist as a draft before publication/);
  assert.match(release, /explorie-\$version-windows-x64-portable\$suffix\.exe/);
  assert.doesNotMatch(release, /windows-x64-setup/);
  assert.match(release, /The Windows portable executable will be unsigned/);
  assert.match(release, /explorie-\$version-macos-arm64\.dmg/);
  assert.match(release, /SHA256SUMS-windows\.txt/);
  assert.match(release, /SHA256SUMS-macos\.txt/);
  assert.match(release, /SIGNTOOL verify \/pa \/v/);
  assert.match(release, /codesign --verify --deep --strict/);
  assert.match(release, /Identifier=com\.omershatz\.explorie\.mountd/);
  assert.match(release, /Identifier=com\.omershatz\.explorie'/);
  assert.doesNotMatch(release, /com\.explorie/);
  assert.match(release, /TeamIdentifier=\$APPLE_TEAM_ID/);
  assert.match(release, /xcrun stapler validate/);
  assert.match(release, /Contents\/Resources\/explorie-mountd/);
  assert.match(release, /Contents\/MacOS\/rclone/);
  assert.match(release, /rclone v1\.74\.4/);
  assert.match(release, /rclone-COPYING/);
  assert.match(release, /winfsp-2\.1\.25156\.msi/);
  assert.match(release, /winfsp-NOTICE/);
  assert.match(release, /pixelarticons-LICENSE/);
  assert.match(release, /NAVIMATICS/);
  assert.match(
    release,
    /Contents\/Library\/LaunchDaemons\/com\.omershatz\.explorie\.mountd\.plist/
  );
  assert.match(release, /Contents\/MacOS\/explorie-gpui/);
  assert.match(release, /spctl --assess/);
  assert.doesNotMatch(release, /softprops\/action-gh-release|gh api -X DELETE/);
  assert.doesNotMatch(release, /apply_update|app\.zip|updater/i);
  assert.match(mountDaemon, /kSecGuestAttributePid/);
  assert.match(mountDaemon, /connection\.processIdentifier/);
  assert.doesNotMatch(mountDaemon, /\.auditToken/);
  assert.match(macosPackage, /CFBundleIdentifier<\/key><string>com\.omershatz\.explorie/);
  assert.match(macosPackage, /codesign --verify --deep --strict/);
  assert.match(macosPackage, /hdiutil create/);
  assert.match(macosPackage, /Contents\/Resources\/explorie-mountd/);
  assert.match(macosPackage, /Contents\/MacOS\/rclone/);
});

test('writeReleaseReports writes timestamped and latest JSON/Markdown files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-check-test-'));
  const report = createReleaseReport({
    context: sampleContext(),
    commands: [
      {
        display: expectedDisplays[0],
        exitCode: 0,
        elapsedMs: 123,
        outputTail: 'ok',
      },
    ],
  });

  try {
    const paths = await writeReleaseReports(report, { outputDir: directory });

    assert.equal(path.basename(paths.jsonPath), 'release-check-20260606-193045.json');
    assert.equal(path.basename(paths.markdownPath), 'release-check-20260606-193045.md');
    assert.equal(path.basename(paths.latestJsonPath), 'latest.json');
    assert.equal(path.basename(paths.latestMarkdownPath), 'latest.md');

    const writtenJson = JSON.parse(await readFile(paths.jsonPath, 'utf8'));
    const latestJson = JSON.parse(await readFile(paths.latestJsonPath, 'utf8'));
    const writtenMarkdown = await readFile(paths.markdownPath, 'utf8');
    const latestMarkdown = await readFile(paths.latestMarkdownPath, 'utf8');

    assert.equal(writtenJson.generatedAt, fixedDate.toISOString());
    assert.deepEqual(latestJson, writtenJson);
    assert.match(writtenMarkdown, /Status: pass/);
    assert.equal(latestMarkdown, writtenMarkdown);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
