import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TAIL_LINES = 120;
const PLAYWRIGHT_RELEASE_PORT = '47173';
const PLAYWRIGHT_RELEASE_BASE_URL = `http://127.0.0.1:${PLAYWRIGHT_RELEASE_PORT}`;

export const DEFAULT_COMMANDS = [
  {
    display: 'pnpm --filter explorie-desktop exec tsc --noEmit',
    command: 'pnpm',
    args: ['--filter', 'explorie-desktop', 'exec', 'tsc', '--noEmit'],
  },
  {
    display: 'pnpm lint:ts',
    command: 'pnpm',
    args: ['lint:ts'],
  },
  {
    display: 'pnpm format:check',
    command: 'pnpm',
    args: ['format:check'],
  },
  {
    display: 'cargo fmt --all -- --check',
    command: 'cargo',
    args: ['fmt', '--all', '--', '--check'],
  },
  {
    display: 'cargo test --workspace',
    command: 'cargo',
    args: ['test', '--workspace'],
  },
  {
    display:
      'cargo clippy --workspace --all-targets --all-features -- -D warnings',
    command: 'cargo',
    args: [
      'clippy',
      '--workspace',
      '--all-targets',
      '--all-features',
      '--',
      '-D',
      'warnings',
    ],
  },
  {
    display: 'pnpm --filter explorie-desktop test',
    command: 'pnpm',
    args: ['--filter', 'explorie-desktop', 'test'],
  },
  {
    display: 'pnpm exec playwright test',
    command: 'pnpm',
    args: ['exec', 'playwright', 'test'],
    env: {
      CI: '1',
      PLAYWRIGHT_BASE_URL: PLAYWRIGHT_RELEASE_BASE_URL,
      PLAYWRIGHT_WEB_COMMAND: `pnpm --filter explorie-desktop exec vite --host 127.0.0.1 --port ${PLAYWRIGHT_RELEASE_PORT} --strictPort`,
    },
  },
  {
    display: 'pnpm --filter explorie-desktop build',
    command: 'pnpm',
    args: ['--filter', 'explorie-desktop', 'build'],
  },
  {
    display: 'pnpm --filter explorie-desktop exec tauri build --no-bundle',
    command: 'pnpm',
    args: [
      '--filter',
      'explorie-desktop',
      'exec',
      'tauri',
      'build',
      '--no-bundle',
    ],
  },
  {
    display: 'git diff --check',
    command: 'git',
    args: ['diff', '--check'],
  },
];

export function tailText(value, maxLines = DEFAULT_TAIL_LINES) {
  if (maxLines <= 0) {
    return '';
  }

  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.split('\n').slice(-maxLines).join('\n');
}

export function getExpectedArtifacts(platform = process.platform) {
  if (platform === 'win32') {
    return ['apps/desktop/frontend/src-tauri/target/release/explorie-desktop.exe'];
  }

  if (platform === 'darwin') {
    return [
      'apps/desktop/frontend/src-tauri/target/release/explorie-desktop',
      'apps/desktop/frontend/src-tauri/target/release/bundle/macos/explorie.app',
    ];
  }

  return ['apps/desktop/frontend/src-tauri/target/release/explorie-desktop'];
}

export function createSpawnInvocation(
  command,
  args = [],
  platform = process.platform,
) {
  if (platform === 'win32' && command === 'pnpm') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm', ...args],
    };
  }

  return { command, args };
}

async function readJsonVersion(rootDir, relativePath) {
  try {
    const content = await readFile(path.join(rootDir, relativePath), 'utf8');
    const parsed = JSON.parse(content);
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function readTauriPackageVersion(rootDir) {
  const candidates = [
    'apps/desktop/frontend/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/Cargo.toml',
  ];

  for (const relativePath of candidates) {
    try {
      const content = await readFile(path.join(rootDir, relativePath), 'utf8');
      const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
      if (match) {
        return match[1];
      }
    } catch {
      // Try the next known Tauri layout.
    }
  }

  return null;
}

function spawnText(command, args, { cwd, env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const invocation = createSpawnInvocation(command, args);
    let child;
    let output = '';
    let settled = false;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(code === 0 ? output.trim() : null);
      }
    });
  });
}

async function getGitText(rootDir, args) {
  return spawnText('git', args, { cwd: rootDir, env: process.env });
}

async function getGitDirty(rootDir) {
  const status = await getGitText(rootDir, ['status', '--porcelain']);
  return status === null ? null : status.length > 0;
}

async function getToolVersions(rootDir) {
  const [pnpm, rustc, cargo, tauri] = await Promise.all([
    spawnText('pnpm', ['--version'], { cwd: rootDir, env: process.env }),
    spawnText('rustc', ['--version'], { cwd: rootDir, env: process.env }),
    spawnText('cargo', ['--version'], { cwd: rootDir, env: process.env }),
    spawnText('pnpm', ['--filter', 'explorie-desktop', 'exec', 'tauri', '--version'], {
      cwd: rootDir,
      env: process.env,
    }),
  ]);

  return { pnpm, rustc, cargo, tauri };
}

export async function collectReleaseContext({
  rootDir = process.cwd(),
  generatedAt = new Date(),
  dirtyBefore,
  dirtyAfter,
} = {}) {
  const generatedAtIso =
    generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  const currentDirty = dirtyBefore ?? (await getGitDirty(rootDir));

  const [
    rootPackageVersion,
    desktopPackageVersion,
    tauriPackageVersion,
    branch,
    shortCommit,
    toolVersions,
  ] = await Promise.all([
    readJsonVersion(rootDir, 'package.json'),
    readJsonVersion(rootDir, 'apps/desktop/frontend/package.json'),
    readTauriPackageVersion(rootDir),
    getGitText(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    getGitText(rootDir, ['rev-parse', '--short', 'HEAD']),
    getToolVersions(rootDir),
  ]);

  return {
    generatedAt: generatedAtIso,
    rootPackageVersion,
    desktopPackageVersion,
    tauriPackageVersion,
    branch,
    shortCommit,
    dirtyBefore: currentDirty,
    dirtyAfter: dirtyAfter ?? currentDirty,
    os: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
    toolVersions,
    expectedArtifacts: getExpectedArtifacts(os.platform()),
  };
}

export function runCommand(commandConfig, { cwd = process.cwd(), env = process.env } = {}) {
  const startedAt = performance.now();
  const commandEnv = {
    ...env,
    ...(commandConfig.env ?? {}),
  };

  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    function finish(exitCode, extraOutput = '') {
      if (settled) {
        return;
      }

      settled = true;
      output += extraOutput;
      resolve({
        display: commandConfig.display,
        exitCode,
        elapsedMs: Math.round(performance.now() - startedAt),
        outputTail: tailText(output),
      });
    }

    const invocation = createSpawnInvocation(
      commandConfig.command,
      commandConfig.args ?? [],
    );
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: commandEnv,
        windowsHide: true,
      });
    } catch (error) {
      finish(127, `\n${error.message}`);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      finish(127, `\n${error.message}`);
    });
    child.on('close', (code) => {
      finish(code ?? 1);
    });
  });
}

export function createReleaseReport({ context, commands }) {
  const failedCommand =
    commands.find((command) => command.exitCode !== 0) ?? null;

  return {
    generatedAt: context.generatedAt,
    status: failedCommand ? 'fail' : 'pass',
    failedCommand,
    context,
    commands,
  };
}

function formatBoolean(value) {
  if (value === null || value === undefined) {
    return 'unknown';
  }

  return value ? 'yes' : 'no';
}

function formatToolVersion(value) {
  return value || 'unavailable';
}

export function renderMarkdownReport(report) {
  const lines = [
    '# Release Check Report',
    '',
    `- Status: ${report.status}`,
    `- Generated: ${report.generatedAt}`,
    `- Branch: ${report.context.branch ?? 'unknown'}`,
    `- Commit: ${report.context.shortCommit ?? 'unknown'}`,
    `- Dirty before: ${formatBoolean(report.context.dirtyBefore)}`,
    `- Dirty after: ${formatBoolean(report.context.dirtyAfter)}`,
    `- Root package version: ${report.context.rootPackageVersion ?? 'unknown'}`,
    `- Desktop package version: ${
      report.context.desktopPackageVersion ?? 'unknown'
    }`,
    `- Tauri package version: ${report.context.tauriPackageVersion ?? 'unknown'}`,
    `- Platform: ${report.context.os}/${report.context.arch}`,
    `- Node: ${report.context.nodeVersion}`,
    `- CPU count: ${report.context.cpuCount}`,
    '',
    '## Tool Versions',
    '',
    `- pnpm: ${formatToolVersion(report.context.toolVersions?.pnpm)}`,
    `- rustc: ${formatToolVersion(report.context.toolVersions?.rustc)}`,
    `- cargo: ${formatToolVersion(report.context.toolVersions?.cargo)}`,
    `- Tauri CLI: ${formatToolVersion(report.context.toolVersions?.tauri)}`,
    '',
    '## Expected Artifacts',
    '',
    ...report.context.expectedArtifacts.map((artifact) => `- \`${artifact}\``),
    '',
    '## Commands',
    '',
  ];

  report.commands.forEach((command, index) => {
    const status = command.exitCode === 0 ? 'pass' : 'fail';
    lines.push(
      `${index + 1}. [${status}] \`${command.display}\``,
      `   - Exit code: ${command.exitCode}`,
      `   - Elapsed: ${command.elapsedMs}ms`,
      '',
      '```text',
      command.outputTail || '(no output)',
      '```',
      '',
    );
  });

  if (report.failedCommand) {
    lines.push(`Failed command: \`${report.failedCommand.display}\``, '');
  }

  return lines.join('\n');
}

function timestampBasename(generatedAt) {
  const date = new Date(generatedAt);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    'release-check-',
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

export async function writeReleaseReports(
  report,
  { rootDir = process.cwd(), outputDir = path.join(rootDir, '.release-checks') } = {},
) {
  await mkdir(outputDir, { recursive: true });

  const basename = timestampBasename(report.generatedAt);
  const jsonPath = path.join(outputDir, `${basename}.json`);
  const markdownPath = path.join(outputDir, `${basename}.md`);
  const latestJsonPath = path.join(outputDir, 'latest.json');
  const latestMarkdownPath = path.join(outputDir, 'latest.md');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = `${renderMarkdownReport(report)}\n`;

  await Promise.all([
    writeFile(jsonPath, json, 'utf8'),
    writeFile(markdownPath, markdown, 'utf8'),
    writeFile(latestJsonPath, json, 'utf8'),
    writeFile(latestMarkdownPath, markdown, 'utf8'),
  ]);

  return {
    jsonPath,
    markdownPath,
    latestJsonPath,
    latestMarkdownPath,
  };
}

export async function runReleaseCheck({
  commands = DEFAULT_COMMANDS,
  rootDir = process.cwd(),
  generatedAt = new Date(),
  collectContext = collectReleaseContext,
  commandRunner = runCommand,
  writeReports = writeReleaseReports,
  outputDir,
} = {}) {
  const context = await collectContext({ rootDir, generatedAt });
  const commandResults = [];

  for (const command of commands) {
    let result;
    try {
      result = await commandRunner(command, { cwd: rootDir, env: process.env });
    } catch (error) {
      result = {
        display: command.display,
        exitCode: 1,
        elapsedMs: 0,
        outputTail: error?.stack ?? String(error),
      };
    }

    commandResults.push({
      display: result.display ?? command.display,
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
      outputTail: result.outputTail ?? '',
    });

    if (result.exitCode !== 0) {
      break;
    }
  }

  const dirtyAfter =
    collectContext === collectReleaseContext
      ? await getGitDirty(rootDir)
      : context.dirtyAfter;
  const report = createReleaseReport({
    context: {
      ...context,
      dirtyAfter,
    },
    commands: commandResults,
  });

  await writeReports(report, { rootDir, outputDir });
  return report;
}

function isDirectInvocation() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  try {
    const report = await runReleaseCheck();
    console.log(
      `Release check ${report.status}. Report written to .release-checks/latest.md`,
    );
    process.exitCode = report.status === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
