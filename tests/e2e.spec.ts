import { test, expect, Page } from '@playwright/test';

type BootstrapData = {
  initialPath: string;
  directories: Record<string, Array<Record<string, any>>>;
  fileContents: Record<string, string>;
  dirSizes: Record<string, number>;
  systemLocations: Record<string, string | string[] | null>;
};

const PLAYWRIGHT_BOOTSTRAP: BootstrapData = {
  initialPath: 'C:/Mock',
  directories: {
    'C:/Mock': [
      {
        id: 'dir-projects',
        path: 'C:/Mock/Projects',
        name: 'Projects',
        size: 0,
        modified: '2024-01-01T12:00:00.000Z',
        hidden: false,
        is_dir: true,
        custom: { status: 'Active' },
      },
      {
        id: 'file-readme',
        path: 'C:/Mock/readme.md',
        name: 'readme.md',
        size: 1_200,
        modified: '2024-01-10T09:00:00.000Z',
        hidden: false,
        is_dir: false,
        custom: { status: 'Docs' },
      },
      {
        id: 'file-manifest',
        path: 'C:/Mock/manifest.json',
        name: 'manifest.json',
        size: 980,
        modified: '2024-01-08T17:30:00.000Z',
        hidden: false,
        is_dir: false,
        custom: { status: 'Config' },
      },
      {
        id: 'file-archive',
        path: 'C:/Mock/archive.zip',
        name: 'archive.zip',
        size: 2_048,
        modified: '2024-01-07T12:00:00.000Z',
        hidden: false,
        is_dir: false,
        custom: { status: 'Archive' },
      },
    ],
    'C:/Mock/Projects': [
      {
        id: 'file-sprint',
        path: 'C:/Mock/Projects/sprint-notes.txt',
        name: 'sprint-notes.txt',
        size: 3_400,
        modified: '2024-01-05T15:15:00.000Z',
        hidden: false,
        is_dir: false,
        custom: { status: 'In Progress' },
      },
    ],
  },
  fileContents: {
    'C:/Mock/readme.md': '# explorie Mock Workspace\nPlaywright proves preview rendering.',
    'C:/Mock/manifest.json': '{ "name": "explorie", "version": "0.1.0" }',
    'C:/Mock/Projects/sprint-notes.txt': 'Sprint notes for mock workspace.',
  },
  dirSizes: {
    'C:/Mock': 7_500,
    'C:/Mock/Projects': 3_400,
  },
  systemLocations: {
    desktop: 'C:/Users/Playwright/Desktop',
    documents: 'C:/Users/Playwright/Documents',
    downloads: 'C:/Users/Playwright/Downloads',
    music: null,
    pictures: null,
    videos: null,
    home: 'C:/Users/Playwright',
    drives: ['C:/'],
  },
};

test.beforeEach(async ({ page }) => {
  await bootstrapExplorie(page);
});

test('lists files and filters via search', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(1);

  await page.getByPlaceholder('Search').fill('manifest');

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('manifest.json');
});

test('opens the preview panel for a selected file', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await clickRow(rows, 'readme.md');

  await expect(page.getByRole('tab', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Preview' })).toContainText(
    'Playwright proves preview rendering.'
  );

  await page.getByRole('tab', { name: 'Metadata' }).click();
  const metadataPanel = page.getByRole('tabpanel', { name: 'Metadata' });
  await expect(metadataPanel.getByText('Name:')).toBeVisible();
  await expect(metadataPanel.getByText('readme.md', { exact: true })).toBeVisible();
});

test('opens Quick Look from Space and shows the file info drawer', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await clickRow(rows, 'readme.md');
  await page.keyboard.press('Space');

  const quickLook = page.getByRole('dialog', { name: 'readme.md' });
  await expect(quickLook).toBeVisible();
  await expect(quickLook.getByText('MD file')).toBeVisible();
  await expect(quickLook.getByText('1.2 KB')).toBeVisible();
  await expect(quickLook.getByRole('tablist', { name: 'Preview tabs' })).toHaveCount(0);
  await expect(quickLook).toContainText('Playwright proves preview rendering.');

  await quickLook.getByRole('button', { name: 'Show file info' }).click();
  await expect(quickLook.getByRole('complementary', { name: 'File info' })).toBeVisible();
  await expect(quickLook.getByText('C:/Mock/readme.md')).toBeVisible();

  await page.keyboard.press('Space');
  await expect(quickLook).toBeHidden();
});

test('keeps Quick Look open while navigating to the next file', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await clickRow(rows, 'archive.zip');
  await page.keyboard.press('Space');

  await expect(page.getByRole('dialog', { name: 'archive.zip' })).toBeVisible();

  await page.keyboard.press('ArrowRight');

  const quickLook = page.getByRole('dialog', { name: 'manifest.json' });
  await expect(quickLook).toBeVisible();
  await expect(quickLook).toContainText('JSON file');
  await expect(quickLook).toContainText('2 / 3');
});

test('navigates into folders and back with the up button', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await dblclickRow(rows, 'Projects');

  await expect(rows.filter({ hasText: 'sprint-notes.txt' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Go to parent folder' }).click();
  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(1);
});

test('drags a file onto a folder to move it', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  const sourceRow = rows.filter({ hasText: 'manifest.json' }).first();
  const targetRow = rows.filter({ hasText: 'Projects' }).first();

  const sourceBox = await sourceRow.boundingBox();
  const targetBox = await targetRow.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  await dblclickRow(rows, 'Projects');
  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(1);
});

test('saves a search as a smart folder and reuses it', async ({ page }) => {
  await openApp(page);

  const searchInput = page.getByPlaceholder('Search');
  await searchInput.fill('manifest');

  page.once('dialog', async (dialog) => {
    await dialog.accept('Manifest Search');
  });

  await page.getByTitle('Save as Smart Folder').click();
  await expect(page.getByLabel('Open Manifest Search')).toBeVisible();

  await page.getByTitle('Clear search').click();
  await expect(searchInput).toHaveValue('');

  await page.getByLabel('Open Manifest Search').click();
  await expect(searchInput).toHaveValue('manifest');
  await expect(tableRows(page)).toHaveCount(1);
});

test('saves and loads workspaces from the command palette', async ({ page }) => {
  await openApp(page);

  await openWorkspaceManager(page);
  const manager = page.getByRole('dialog', { name: 'Workspace Manager' });

  await manager.getByPlaceholder('Workspace name...').fill('Playwright Workspace');
  await manager.getByRole('button', { name: 'Save' }).click();
  await expect(manager.getByText('Playwright Workspace')).toBeVisible();
  await manager.getByText('Close', { exact: true }).click();

  const rows = tableRows(page);
  await dblclickRow(rows, 'Projects');
  await expect(rows.filter({ hasText: 'sprint-notes.txt' })).toHaveCount(1);

  await openWorkspaceManager(page);
  await page
    .getByRole('dialog', { name: 'Workspace Manager' })
    .getByText('Playwright Workspace')
    .click();
  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'sprint-notes.txt' })).toHaveCount(0);
});

test('opens batch rename preview from the context menu', async ({ page }) => {
  await openApp(page);

  await page.getByRole('button', { name: 'Change view mode' }).click();
  await page.getByRole('menuitemradio', { name: 'Grid' }).click();

  const readmeItem = page.getByLabel('Select file readme.md');
  const manifestItem = page.getByLabel('Select file manifest.json');
  await readmeItem.click();
  await manifestItem.click({ modifiers: ['Control'] });
  await manifestItem.click({ button: 'right' });

  await page.getByText('Batch Rename (2)').click();
  await expect(page.getByRole('heading', { name: 'Batch Rename' })).toBeVisible();

  await page.getByRole('button', { name: 'Prefix/Suffix' }).click();
  await page.getByPlaceholder('Add before name...').fill('new_');

  await expect(page.getByText('new_readme.md')).toBeVisible();
  await expect(page.getByText('new_manifest.json')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename 2 Files' })).toBeEnabled();
});

test('opens the create archive dialog from the context menu', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await rows
    .filter({ hasText: 'readme.md' })
    .first()
    .locator('td')
    .first()
    .click({ button: 'right' });
  await page.getByText('Compress').click();

  await expect(page.getByRole('heading', { name: 'Create Archive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Archive' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('shows archive contents when extracting', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await rows
    .filter({ hasText: 'archive.zip' })
    .first()
    .locator('td')
    .first()
    .click({ button: 'right' });
  await page.getByText('Extract Here').click();

  await expect(page.getByRole('heading', { name: 'Extract Archive' })).toBeVisible();
  await expect(page.getByText('docs/readme.md')).toBeVisible();
});

test('copies and pastes via context menu with undo/redo', async ({ page }) => {
  await openApp(page);

  const rows = tableRows(page);
  await rows
    .filter({ hasText: 'readme.md' })
    .first()
    .locator('td')
    .first()
    .click({ button: 'right' });
  await page.getByText('Copy').click();

  await page.getByRole('columnheader', { name: 'Name' }).click({ button: 'right' });
  await page.getByText('Paste').click();
  await page.getByRole('button', { name: 'Keep Both' }).click();
  await expect(rows.filter({ hasText: 'readme (2).md' })).toHaveCount(1);

  await page.getByTitle(/Undo/).click();
  await expect(rows.filter({ hasText: 'readme (2).md' })).toHaveCount(0);

  await page.getByTitle(/Redo/).click();
  await expect(rows.filter({ hasText: 'readme (2).md' })).toHaveCount(1);
});

test('persists settings across reloads', async ({ page }) => {
  await openApp(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  const folderSizesToggle = page.getByLabel('Show folder sizes');
  await folderSizesToggle.check();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.reload();
  await expect(page.getByPlaceholder('Search')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByLabel('Show folder sizes')).toBeChecked();
  await page.getByRole('button', { name: 'Close settings' }).click();
});

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByPlaceholder('Search')).toBeVisible();
  await expect(tableRows(page)).toHaveCount(4);
}

async function openWorkspaceManager(page: Page) {
  await page.keyboard.press('Control+Shift+P');
  const paletteInput = page.getByPlaceholder('Type a command or search...');
  await expect(paletteInput).toBeVisible();
  await paletteInput.fill('workspace');
  await page.getByText('Manage Workspaces', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace Manager' })).toBeVisible();
}

function tableRows(page: Page) {
  return page.locator('table tbody tr').filter({ has: page.locator('td') });
}

async function clickRow(rows: ReturnType<typeof tableRows>, text: string) {
  const row = rows.filter({ hasText: text }).first();
  await row.locator('td').first().click();
}

async function dblclickRow(rows: ReturnType<typeof tableRows>, text: string) {
  const row = rows.filter({ hasText: text }).first();
  await row.locator('td').first().dblclick();
}

async function bootstrapExplorie(page: Page) {
  await page.addInitScript(
    ({ bootstrap }) => {
      const normalizePath = (value?: string) => {
        if (!value) return '';
        const replaced = String(value).replace(/\\+/g, '/');
        if (replaced === '/') return '/';
        return replaced.replace(/\/+$/, '') || '/';
      };

      const entriesByDir: Record<string, Array<Record<string, any>>> = {};
      for (const [dir, entries] of Object.entries(bootstrap.directories)) {
        const key = normalizePath(dir);
        entriesByDir[key] = entries.map((entry) => ({
          ...entry,
          path: normalizePath(entry.path),
          custom: { ...(entry.custom || {}) },
        }));
      }

      const encoder = new TextEncoder();
      const fileContents: Record<string, Uint8Array> = {};
      for (const [filePath, text] of Object.entries(bootstrap.fileContents)) {
        fileContents[normalizePath(filePath)] = encoder.encode(text);
      }

      const dirSizeMap: Record<string, number> = {};
      for (const [dir, size] of Object.entries(bootstrap.dirSizes)) {
        dirSizeMap[normalizePath(dir)] = size;
      }

      const initialPath = normalizePath(bootstrap.initialPath);
      const tabId = 'tab-playwright';
      const tabs = [{ id: tabId, path: initialPath }];
      window.localStorage.setItem('explorie:currentPath', initialPath);
      window.localStorage.setItem('explorie:tabs', JSON.stringify(tabs));
      window.localStorage.setItem('explorie:activeTabId', tabId);
      window.localStorage.setItem('explorie:showPreviewPanel', 'true');
      window.localStorage.setItem('explorie:viewMode', 'list');

      const encode = (value: string) => encoder.encode(value);
      const cloneEntries = (items: Array<Record<string, any>>) =>
        items.map((item) => ({ ...item, custom: { ...(item.custom || {}) } }));

      const isRootPath = (value: string) => value === '/' || /^[A-Za-z]:\/$/.test(value);
      const getParentPath = (value: string) => {
        const normalized = normalizePath(value);
        if (isRootPath(normalized)) return normalized;
        const trimmed = normalized.replace(/\/$/, '');
        return trimmed.replace(/\/[^/]+$/, '') || '/';
      };
      const getBaseName = (value: string) => {
        const trimmed = normalizePath(value).replace(/\/$/, '');
        return trimmed.split('/').pop() || trimmed;
      };
      const ensureDir = (dirPath: string) => {
        const key = normalizePath(dirPath);
        if (!entriesByDir[key]) {
          entriesByDir[key] = [];
        }
      };
      const findEntry = (path: string) => {
        const normalized = normalizePath(path);
        const dir = getParentPath(normalized);
        const list = entriesByDir[dir] || [];
        const idx = list.findIndex((entry) => normalizePath(entry.path) === normalized);
        return { dir, list, idx, entry: idx >= 0 ? list[idx] : null };
      };
      let entrySeq = 0;
      const nextId = () => `pw-entry-${++entrySeq}`;
      const upsertFileEntry = (path: string, size: number) => {
        const normalized = normalizePath(path);
        const name = getBaseName(normalized);
        const { dir, idx } = findEntry(normalized);
        ensureDir(dir);
        const list = entriesByDir[dir];
        const now = new Date().toISOString();
        if (idx >= 0) {
          list[idx] = { ...list[idx], path: normalized, name, size, modified: now, is_dir: false };
        } else {
          list.push({
            id: nextId(),
            path: normalized,
            name,
            size,
            modified: now,
            hidden: false,
            is_dir: false,
            custom: {},
          });
        }
      };
      const upsertDirEntry = (path: string) => {
        const normalized = normalizePath(path);
        const name = getBaseName(normalized);
        ensureDir(normalized);
        const { dir, idx } = findEntry(normalized);
        ensureDir(dir);
        const list = entriesByDir[dir];
        if (idx >= 0) return;
        list.push({
          id: nextId(),
          path: normalized,
          name,
          size: 0,
          modified: new Date().toISOString(),
          hidden: false,
          is_dir: true,
          custom: {},
        });
      };
      const removeEntryRecursive = (path: string) => {
        const normalized = normalizePath(path);
        const { dir, list, idx, entry } = findEntry(normalized);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
        delete fileContents[normalized];
        if (entry?.is_dir && entriesByDir[normalized]) {
          const childEntries = entriesByDir[normalized] || [];
          for (const child of childEntries) {
            removeEntryRecursive(child.path);
          }
          delete entriesByDir[normalized];
        }
      };
      const renameEntry = (fromPath: string, toPath: string) => {
        const from = normalizePath(fromPath);
        const to = normalizePath(toPath);
        const info = findEntry(from);
        if (!info.entry) return;
        const entry = info.entry;
        info.list.splice(info.idx, 1);
        const destDir = getParentPath(to);
        ensureDir(destDir);
        const updated = { ...entry, path: to, name: getBaseName(to) };
        entriesByDir[destDir].push(updated);
        if (entry.is_dir && entriesByDir[from]) {
          entriesByDir[to] = entriesByDir[from];
          delete entriesByDir[from];
        }
        if (fileContents[from]) {
          fileContents[to] = fileContents[from];
          delete fileContents[from];
        }
      };

      const globalWindow = window as Window &
        typeof globalThis & {
          __TAURI_INTERNALS__?: any;
          isTauri?: boolean;
          [key: string]: any;
        };
      globalWindow.isTauri = true;
      const callbacks = new Map<string, { cb: (...args: any[]) => void; once: boolean }>();
      let callbackSeq = 0;

      globalWindow.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { windowLabel: 'main', label: 'main' },
        },
        invoke(
          command: string,
          options: Record<string, any> | Uint8Array | number[] = {},
          requestOptions: { headers?: Record<string, string> } = {}
        ) {
          const optionRecord =
            options instanceof Uint8Array || Array.isArray(options) ? {} : options;
          const headerPath = requestOptions.headers?.path
            ? decodeURIComponent(requestOptions.headers.path)
            : undefined;
          const optionPath = typeof optionRecord.path === 'string' ? optionRecord.path : undefined;
          const normalizedPath =
            optionPath || headerPath ? normalizePath(optionPath || headerPath) : undefined;

          switch (command) {
            case 'list_files':
              return Promise.resolve(
                cloneEntries(entriesByDir[normalizedPath || initialPath] || [])
              );
            case 'get_dir_size':
              return Promise.resolve(dirSizeMap[normalizedPath || initialPath] || 0);
            case 'list_system_locations':
              return Promise.resolve(bootstrap.systemLocations);
            case 'list_archive':
              return Promise.resolve({
                format: 'zip',
                total_size: 5_000,
                compressed_size: 2_000,
                entry_count: 2,
                entries: [
                  {
                    name: 'docs',
                    path: 'docs',
                    size: 0,
                    compressed_size: 0,
                    is_dir: true,
                  },
                  {
                    name: 'docs/readme.md',
                    path: 'docs/readme.md',
                    size: 120,
                    compressed_size: 60,
                    is_dir: false,
                  },
                ],
              });
            case 'compress_files': {
              const outputPath = normalizePath(
                optionRecord.outputPath || `${initialPath}/Archive.zip`
              );
              const totalBytes = Array.isArray(optionRecord.paths)
                ? optionRecord.paths.length * 1024
                : 1024;
              upsertFileEntry(outputPath, totalBytes);
              return Promise.resolve({ output_path: outputPath, total_bytes: totalBytes });
            }
            case 'extract_archive_cmd':
              return Promise.resolve({
                output_dir: normalizePath(optionRecord.outputDir || initialPath),
                total_bytes: 5_000,
              });
            case 'is_default_file_manager':
              return Promise.resolve(false);
            case 'set_default_file_manager':
            case 'revert_default_file_manager':
            case 'create_explorie_schema':
            case 'update_custom_fields':
            case 'open_path':
              return Promise.resolve(null);
          }

          if (command === 'plugin:fs|read_text_file' || command === 'plugin:fs|read_file') {
            const key = normalizedPath || '';
            const bytes = fileContents[key] || encode('');
            return Promise.resolve(bytes);
          }

          if (command === 'plugin:fs|exists') {
            const key = normalizedPath || '';
            const { entry } = findEntry(key);
            const exists = key in fileContents || key in entriesByDir || !!entry;
            return Promise.resolve(exists);
          }

          if (command === 'plugin:fs|stat') {
            const key = normalizedPath || '';
            if (key in entriesByDir) {
              return Promise.resolve({ isDirectory: true, isFile: false, readonly: false });
            }
            const { entry } = findEntry(key);
            if (entry) {
              return Promise.resolve({
                isDirectory: !!entry.is_dir,
                isFile: !entry.is_dir,
                readonly: false,
              });
            }
            return Promise.resolve({ isDirectory: false, isFile: false, readonly: false });
          }

          if (command === 'plugin:fs|read_dir') {
            const key = normalizedPath || '';
            const entries = (entriesByDir[key] || []).map((entry) => ({
              path: entry.path,
              name: entry.name || getBaseName(entry.path),
              children: entry.is_dir ? [] : undefined,
            }));
            return Promise.resolve(entries);
          }

          if (command === 'plugin:fs|mkdir') {
            const key = normalizedPath || optionRecord.path;
            if (typeof key === 'string') {
              upsertDirEntry(key);
              ensureDir(key);
            }
            return Promise.resolve(null);
          }

          if (command === 'plugin:fs|rename') {
            const from = optionRecord.from || optionRecord.oldPath || optionRecord.path;
            const to = optionRecord.to || optionRecord.newPath;
            if (typeof from === 'string' && typeof to === 'string') {
              renameEntry(from, to);
            }
            return Promise.resolve(null);
          }

          if (command === 'plugin:fs|remove') {
            const key = normalizedPath || optionRecord.path;
            if (typeof key === 'string') {
              removeEntryRecursive(key);
            }
            return Promise.resolve(null);
          }

          if (command === 'plugin:fs|write_file' || command === 'plugin:fs|write_text_file') {
            const key = normalizedPath || optionRecord.path;
            const payload =
              options instanceof Uint8Array || Array.isArray(options)
                ? options
                : (optionRecord.contents ??
                  optionRecord.data ??
                  optionRecord.bytes ??
                  optionRecord.content ??
                  '');
            let bytes: Uint8Array;
            if (typeof payload === 'string') {
              bytes = encode(payload);
            } else if (payload instanceof Uint8Array) {
              bytes = payload;
            } else if (Array.isArray(payload)) {
              bytes = new Uint8Array(payload);
            } else {
              bytes = encode(String(payload));
            }
            if (typeof key === 'string') {
              fileContents[normalizePath(key)] = bytes;
              upsertFileEntry(key, bytes.length);
            }
            return Promise.resolve(null);
          }

          if (command.startsWith('plugin:fs|')) {
            return Promise.resolve(null);
          }

          console.warn('Unhandled mocked Tauri command', command, options);
          return Promise.resolve(null);
        },
        transformCallback(callback: (...args: any[]) => void, once = false) {
          const id = `pw-cb-${++callbackSeq}`;
          callbacks.set(id, { cb: callback, once });
          globalWindow[id] = (...args: any[]) => {
            const entry = callbacks.get(id);
            if (!entry) return;
            entry.cb(...args);
            if (entry.once) {
              callbacks.delete(id);
              delete globalWindow[id];
            }
          };
          return id;
        },
        convertFileSrc(pathValue: string) {
          return `mock://${normalizePath(pathValue)}`;
        },
      };
    },
    { bootstrap: PLAYWRIGHT_BOOTSTRAP }
  );
}
