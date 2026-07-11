import { execSync } from 'node:child_process';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Resolve the current git short hash at build time; fall back when git is unavailable.
function resolveGitHash(): string {
  try {
    return execSync('git rev-parse --short=8 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

// Export async to conditionally include analyzer without hard dependency
export default defineConfig(async ({ mode }) => {
  // Load env vars from .env files
  const env = loadEnv(mode, process.cwd(), '');

  const enableAnalyze =
    process.env.ANALYZE === '1' || process.env.npm_lifecycle_event === 'analyze';
  const plugins: Plugin[] = [react()];
  if (enableAnalyze) {
    try {
      const { visualizer } = await import('rollup-plugin-visualizer');
      plugins.push(
        visualizer({
          filename: 'dist/stats.html',
          open: false,
          gzipSize: true,
          brotliSize: true,
        }) as Plugin
      );
    } catch {
      // Analyzer not installed; skip silently
    }
  }

  // Environment-configurable values with defaults
  const devPort = parseInt(env.VITE_DEV_PORT || '5173', 10);
  const dropConsole = env.VITE_DROP_CONSOLE !== 'false';

  return {
    root: '.',
    plugins,
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
      __GIT_HASH__: JSON.stringify(resolveGitHash()),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      cssCodeSplit: true,
      sourcemap: env.VITE_SOURCEMAP === 'true',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('/react') || id.includes('\\react')) return 'react';
            if (id.includes('/zustand') || id.includes('\\zustand')) return 'zustand';
            if (id.includes('/@tauri-apps/') || id.includes('\\@tauri-apps\\')) return 'tauri';
            return undefined;
          },
        },
      },
    },
    esbuild: {
      drop: dropConsole ? ['console', 'debugger'] : [],
    },
    server: {
      port: devPort,
      strictPort: env.VITE_STRICT_PORT !== 'false',
    },
    optimizeDeps: {
      exclude: ['@tauri-apps/api'],
    },
  };
});
