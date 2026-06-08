import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as releaseCheck from './release-check.mjs';

const {
  DEFAULT_COMMANDS,
  createSpawnInvocation,
  createReleaseReport,
  getExpectedArtifacts,
  renderMarkdownReport,
  runCommand,
  runReleaseCheck,
  tailText,
  writeReleaseReports,
} = releaseCheck;

const expectedDisplays = [
  'pnpm --filter explorie-desktop exec tsc --noEmit',
  'pnpm lint:ts',
  'pnpm format:check',
  'cargo fmt --all -- --check',
  'cargo test --workspace',
  'cargo clippy --workspace --all-targets --all-features -- -D warnings',
  'pnpm --filter explorie-desktop test',
  'pnpm exec playwright test',
  'pnpm --filter explorie-desktop build',
  'pnpm --filter explorie-desktop exec tauri build --no-bundle',
  'git diff --check',
];

const fixedDate = new Date('2026-06-06T19:30:45.000Z');

function sampleContext() {
  return {
    generatedAt: fixedDate.toISOString(),
    rootPackageVersion: '0.1.0',
    desktopPackageVersion: '0.1.0',
    tauriPackageVersion: '0.1.0',
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
      tauri: '2.5.0',
    },
    expectedArtifacts: [
      'apps/desktop/frontend/src-tauri/target/release/explorie-desktop.exe',
    ],
  };
}

test('DEFAULT_COMMANDS preserves exact display order and representative execution specs', () => {
  assert.deepEqual(
    DEFAULT_COMMANDS.map((command) => command.display),
    expectedDisplays,
  );

  assert.equal(DEFAULT_COMMANDS[0].command, 'pnpm');
  assert.deepEqual(DEFAULT_COMMANDS[0].args, [
    '--filter',
    'explorie-desktop',
    'exec',
    'tsc',
    '--noEmit',
  ]);
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
  assert.equal(DEFAULT_COMMANDS[9].command, 'pnpm');
  assert.deepEqual(DEFAULT_COMMANDS[9].args, [
    '--filter',
    'explorie-desktop',
    'exec',
    'tauri',
    'build',
    '--no-bundle',
  ]);
  assert.equal(DEFAULT_COMMANDS[10].command, 'git');
  assert.deepEqual(DEFAULT_COMMANDS[10].args, ['diff', '--check']);
});

test('Playwright release command uses an isolated strict dev server port', () => {
  const command = DEFAULT_COMMANDS.find(
    (candidate) => candidate.display === 'pnpm exec playwright test',
  );

  assert.deepEqual(command.env, {
    CI: '1',
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:47173',
    PLAYWRIGHT_WEB_COMMAND:
      'pnpm --filter explorie-desktop exec vite --host 127.0.0.1 --port 47173 --strictPort',
  });
});

test('getExpectedArtifacts uses the actual desktop Tauri workspace layout', () => {
  assert.deepEqual(getExpectedArtifacts('win32'), [
    'apps/desktop/frontend/src-tauri/target/release/explorie-desktop.exe',
  ]);
  assert.deepEqual(getExpectedArtifacts('darwin'), [
    'apps/desktop/frontend/src-tauri/target/release/explorie-desktop',
    'apps/desktop/frontend/src-tauri/target/release/bundle/macos/explorie.app',
  ]);
  assert.deepEqual(getExpectedArtifacts('linux'), [
    'apps/desktop/frontend/src-tauri/target/release/explorie-desktop',
  ]);
});

test('createSpawnInvocation shells pnpm on Windows only', () => {
  assert.equal(typeof releaseCheck.createSpawnInvocation, 'function');
  assert.deepEqual(
    createSpawnInvocation('pnpm', ['--version'], 'win32'),
    {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm', '--version'],
    },
  );
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
  assert.match(
    markdown,
    /apps\/desktop\/frontend\/src-tauri\/target\/release\/explorie-desktop\.exe/,
  );
  assert.match(markdown, /pnpm --filter explorie-desktop exec tsc --noEmit/);
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
  },
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
  assert.equal(report.commands.length, 2);
  assert.equal(report.failedCommand.display, 'second');
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

    assert.equal(
      path.basename(paths.jsonPath),
      'release-check-20260606-193045.json',
    );
    assert.equal(
      path.basename(paths.markdownPath),
      'release-check-20260606-193045.md',
    );
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
