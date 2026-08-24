import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const { chromium } = require('@playwright/test');

const port = 47174;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    '--filter',
    'explorie-desktop',
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: process.cwd(),
    stdio: 'ignore',
    shell: process.platform === 'win32',
  }
);

function stopServer() {
  if (server.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}

async function waitForVite(page) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Vite did not start at ${baseUrl}`);
}

async function measureView(page, count, view) {
  if (count === 100_000) {
    await page.route('**/src/App.tsx**', async (route) => {
      const response = await route.fetch();
      const original = await response.text();
      const body = original.replace(
        /Array\.from\(\{\s*length:\s*(?:1e4|10000)\s*\}\)/,
        'Array.from({ length: 1e5 })'
      );
      if (body === original) {
        throw new Error('Unable to expand the development listing fixture to 100,000 entries');
      }
      await route.fulfill({ response, body });
    });
  }

  await page.addInitScript((requestedView) => {
    localStorage.setItem('explorie:viewMode', requestedView);
    const state = {
      firstList: null,
      firstVisible: null,
      sortingStart: null,
      sortingEnd: null,
      workerStart: null,
      workerEnd: null,
    };
    window.__listingPerf = state;
    if (!window.__listingPerfWorkerWrapped) {
      const NativeWorker = window.Worker;
      class MeasuredWorker extends NativeWorker {
        postMessage(...args) {
          const payload = args[0];
          if (
            payload &&
            Array.isArray(payload.files) &&
            payload.files.length >= 5_000 &&
            window.__listingPerf
          ) {
            window.__listingPerf.workerStart = performance.now();
          }
          return super.postMessage(...args);
        }

        constructor(...args) {
          super(...args);
          this.addEventListener('message', () => {
            if (window.__listingPerf?.workerStart !== null) {
              window.__listingPerf.workerEnd ??= performance.now();
            }
          });
        }
      }
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        value: MeasuredWorker,
      });
      window.__listingPerfWorkerWrapped = true;
    }
    const sample = () => {
      const now = performance.now();
      const listing = document.querySelector('[aria-label*="Files in current folder"]');
      const visibleCount =
        requestedView === 'list'
          ? document.querySelectorAll('table tbody tr').length
          : document.querySelectorAll('[role="option"]').length;
      const spinner = document.querySelector('[aria-label="sorting"]');
      if (listing && state.firstList === null) state.firstList = now;
      if (visibleCount > 0 && state.firstVisible === null) state.firstVisible = now;
      if (spinner && state.sortingStart === null) state.sortingStart = now;
      if (!spinner && state.sortingStart !== null && state.sortingEnd === null) {
        state.sortingEnd = now;
      }
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    window.__listingPerfSample = sample;
  }, view);

  await waitForVite(page);
  await page.getByPlaceholder('Search').waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForFunction(
    ({ expectedCount, expectedView }) => {
      const listing = document.querySelector(
        `[aria-label="Files in current folder, ${expectedCount} items"]`
      );
      const visibleCount =
        expectedView === 'list'
          ? document.querySelectorAll('table tbody tr').length
          : document.querySelectorAll('[role="option"]').length;
      const workerFinished = window.__listingPerf?.workerEnd !== null;
      return Boolean(listing && visibleCount > 0 && workerFinished);
    },
    { expectedCount: count, expectedView: view },
    { timeout: 120_000 }
  );

  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );

  const result = await page.evaluate(() => {
    window.__listingPerfSample?.();
    const state = window.__listingPerf;
    const now = performance.now();
    const visible =
      document.querySelectorAll('[role="option"]').length ||
      document.querySelectorAll('table tbody tr').length;
    return {
      ...state,
      visible,
      listToVisibleMs:
        state.firstList !== null && state.firstVisible !== null
          ? state.firstVisible - state.firstList
          : null,
      workerMs:
        state.workerStart !== null && state.workerEnd !== null
          ? state.workerEnd - state.workerStart
          : null,
      reactAfterWorkerMs:
        state.workerEnd !== null ? now - state.workerEnd : null,
      sortAndReactMs:
        state.workerStart !== null && state.workerEnd !== null
          ? now - state.workerStart
          : state.sortingStart !== null && state.sortingEnd !== null
            ? state.sortingEnd - state.sortingStart
            : null,
    };
  });

  await page.unroute('**/src/App.tsx**').catch(() => {});
  return { count, view, ...result };
}

async function measureWorkerAndBoundary(page) {
  return page.evaluate(async () => {
    const count = 100_000;
    const files = Array.from({ length: count }, (_, index) => ({
      id: `id-${index}`,
      path: `/bench/file-${String(count - index).padStart(6, '0')}.txt`,
      name: `file-${String(count - index).padStart(6, '0')}.txt`,
      size: index,
      modified: { secs_since_epoch: 1_700_000_000 + index, nanos_since_epoch: 0 },
      hidden: false,
      is_dir: false,
      custom: {},
      is_symlink: false,
      is_junction: false,
      has_xattrs: false,
    }));

    const jsonStart = performance.now();
    const json = JSON.stringify(files);
    const jsonMs = performance.now() - jsonStart;
    const parseStart = performance.now();
    const parsed = JSON.parse(json);
    const parseMs = performance.now() - parseStart;
    const cloneStart = performance.now();
    const cloned = structuredClone(files);
    const cloneMs = performance.now() - cloneStart;

    const source = await fetch('/src/workers/sortWorker.ts').then((response) => response.text());
    const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl, { type: 'module' });
    const workerStart = performance.now();
    const sorted = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ files, key: 'name', dir: 'asc' });
    });
    const workerMs = performance.now() - workerStart;
    worker.terminate();
    URL.revokeObjectURL(workerUrl);

    return {
      count,
      jsonBytes: json.length,
      jsonMs,
      parseMs,
      structuredCloneMs: cloneMs,
      workerPostMessageAndSortMs: workerMs,
      parsedEntries: parsed.length,
      clonedEntries: cloned.length,
      sortedEntries: sorted.length,
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const views = [];
  for (const count of [10_000, 100_000]) {
    for (const view of ['list', 'grid']) {
      views.push(await measureView(page, count, view));
    }
  }
  const workerAndBoundary = await measureWorkerAndBoundary(page);
  console.log(JSON.stringify({ views, workerAndBoundary }, null, 2));
} finally {
  await browser.close();
  stopServer();
}
