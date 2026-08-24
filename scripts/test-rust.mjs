import { spawnSync } from 'node:child_process';

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const result = spawnSync(cargo, ['test', '--workspace', ...process.argv.slice(2)], {
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({
      bundle: {
        externalBin: [],
        resources: null,
      },
    }),
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to run ${cargo}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
