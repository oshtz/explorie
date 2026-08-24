import { spawnSync } from 'node:child_process';

process.env.TAURI_CONFIG = JSON.stringify({
  bundle: { externalBin: [], resources: [] },
});

const result = spawnSync('cargo', ['test', '--workspace'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
