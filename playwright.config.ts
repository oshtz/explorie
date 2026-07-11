import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:47173';
const webCommand =
  process.env.PLAYWRIGHT_WEB_COMMAND ||
  'pnpm --filter explorie-desktop exec vite --host 127.0.0.1 --port 47173 --strictPort';
const shouldStartServer = !process.env.PLAYWRIGHT_SKIP_WEB_SERVER;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  webServer: shouldStartServer
    ? {
        command: webCommand,
        url: baseURL,
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    : undefined,
});
