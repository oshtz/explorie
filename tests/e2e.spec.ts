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
  await openFolderRow(rows, 'Projects');

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
  expect(sourceBox).not.toBeNull();

  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2 + 8,
    sourceBox!.y + sourceBox!.height / 2
  );
  await expect(page.getByTestId('drag-overlay')).toBeVisible();
  const targetBox = await targetRow.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 8,
  });
  await expect(targetRow).toHaveClass(/dropTargetRow/);
  await page.mouse.up();

  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  await openFolderRow(rows, 'Projects');
  await expect(rows.filter({ hasText: 'manifest.json' })).toHaveCount(1);
});

test('saves a search as a smart folder and reuses it', async ({ page }) => {
  await openApp(page);

  const searchInput = page.getByPlaceholder('Search');
  await searchInput.fill('manifest');

  await page.getByTitle('Save as Smart Folder').click();
  const saveSearch = page.getByRole('dialog', { name: 'Save search' });
  await saveSearch.getByRole('textbox', { name: 'Name' }).fill('Manifest Search');
  await saveSearch.getByRole('button', { name: 'Save' }).click();
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
  await openFolderRow(rows, 'Projects');
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
  await page
    .getByRole('group', { name: 'View options' })
    .getByRole('button', { name: 'Grid' })
    .click();

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
  await page.getByRole('menuitem', { name: 'Advanced' }).click();
  await page.getByRole('menuitem', { name: 'Compress' }).click();

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
  await page.getByRole('menuitem', { name: 'Advanced' }).click();
  await page.getByRole('menuitem', { name: 'Extract Here' }).click();

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
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'General' }).click();
  const folderSizesToggle = page.getByLabel('Show folder sizes');
  await folderSizesToggle.check();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await page.reload();
  await expect(page.getByPlaceholder('Search')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await settings.getByRole('button', { name: 'General' }).click();
  await expect(page.getByLabel('Show folder sizes')).toBeChecked();
  await settings.getByRole('button', { name: 'Close settings' }).click();
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

async function openFolderRow(rows: ReturnType<typeof tableRows>, text: string) {
  const row = rows.filter({ hasText: text }).first();
  await row.focus();
  await row.press('Enter');
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
      const decoder = new TextDecoder();
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

      const pathExists = (path: string) => {
        const normalized = normalizePath(path);
        return (
          normalized in fileContents ||
          normalized in entriesByDir ||
          findEntry(normalized).entry !== null
        );
      };
      const nextAvailablePath = (path: string) => {
        const normalized = normalizePath(path);
        const parent = getParentPath(normalized);
        const name = getBaseName(normalized);
        const extensionIndex = name.lastIndexOf('.');
        const hasExtension = extensionIndex > 0;
        const stem = hasExtension ? name.slice(0, extensionIndex) : name;
        const extension = hasExtension ? name.slice(extensionIndex) : '';
        let suffix = 2;
        let candidate = `${parent}/${stem} (${suffix})${extension}`;
        while (pathExists(candidate)) {
          suffix += 1;
          candidate = `${parent}/${stem} (${suffix})${extension}`;
        }
        return normalizePath(candidate);
      };
      const resolveTarget = (source: string, destination: string, policy: string) => {
        const requested = normalizePath(`${destination}/${getBaseName(source)}`);
        if (!pathExists(requested)) return requested;
        if (policy === 'rename') return nextAvailablePath(requested);
        if (policy === 'replace' && normalizePath(source) !== requested) {
          removeEntryRecursive(requested);
          return requested;
        }
        throw new Error(`Destination already exists: ${requested}`);
      };
      const copyFileEntry = (sourcePath: string, targetPath: string) => {
        const source = normalizePath(sourcePath);
        const target = normalizePath(targetPath);
        const { entry } = findEntry(source);
        if (!entry) throw new Error(`Source does not exist: ${source}`);
        if (entry.is_dir) throw new Error('The Playwright native mock only copies files');
        const targetDir = getParentPath(target);
        ensureDir(targetDir);
        entriesByDir[targetDir].push({
          ...entry,
          id: nextId(),
          path: target,
          name: getBaseName(target),
          custom: { ...(entry.custom || {}) },
        });
        if (fileContents[source]) {
          fileContents[target] = fileContents[source].slice();
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
      const eventListeners = new Map<number, { event: string; handler: string }>();
      let callbackSeq = 0;
      let eventSeq = 0;
      let jobSeq = 0;
      const activeJobs = new Set<string>();
      const cancelledJobs = new Set<string>();

      globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(_event: string, eventId: number) {
          eventListeners.delete(Number(eventId));
        },
      };

      const emitMockEvent = (event: string, payload: Record<string, any>) => {
        for (const [id, listener] of eventListeners) {
          if (listener.event === event) {
            globalWindow[listener.handler]?.({ event, id, payload });
          }
        }
      };

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
            case 'read_text_preview': {
              const bytes = fileContents[normalizedPath || ''] || encode('');
              const maxBytes = Math.max(0, Number(optionRecord.maxBytes) || 0);
              return Promise.resolve({
                text: decoder.decode(bytes.slice(0, maxBytes)),
                truncated: bytes.length > maxBytes,
              });
            }
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
            case 'create_explorie_schema':
            case 'update_custom_fields':
            case 'open_path':
              return Promise.resolve(null);
            case 'rename_path': {
              const source = normalizePath(String(optionRecord.sourcePath || ''));
              const requested = normalizePath(
                `${getParentPath(source)}/${String(optionRecord.newBaseName || '')}`
              );
              const destination = pathExists(requested) ? nextAvailablePath(requested) : requested;
              renameEntry(source, destination);
              return Promise.resolve(destination);
            }
            case 'delete_path_permanently': {
              removeEntryRecursive(normalizePath(String(optionRecord.path || '')));
              return Promise.resolve(null);
            }
            case 'create_folder':
            case 'create_note':
            case 'create_website_link': {
              const directory = normalizePath(String(optionRecord.dirPath || ''));
              const requested = normalizePath(
                `${directory}/${String(optionRecord.baseName || '')}`
              );
              const created = pathExists(requested) ? nextAvailablePath(requested) : requested;
              if (command === 'create_folder') {
                upsertDirEntry(created);
                ensureDir(created);
              } else {
                const contents =
                  command === 'create_note'
                    ? '# New Note\n'
                    : `[InternetShortcut]\nURL=${String(optionRecord.url || '')}\n`;
                const bytes = encode(contents);
                fileContents[created] = bytes;
                upsertFileEntry(created, bytes.length);
              }
              return Promise.resolve(created);
            }
            case 'plugin:event|listen': {
              const eventId = ++eventSeq;
              eventListeners.set(eventId, {
                event: String(optionRecord.event),
                handler: String(optionRecord.handler),
              });
              return Promise.resolve(eventId);
            }
            case 'plugin:event|unlisten':
              eventListeners.delete(Number(optionRecord.eventId));
              return Promise.resolve(null);
            case 'start_file_operation': {
              const request = optionRecord.request || {};
              const sources = Array.isArray(request.sources)
                ? request.sources.map((source: unknown) => normalizePath(String(source)))
                : [];
              const jobId = `pw-job-${++jobSeq}`;
              activeJobs.add(jobId);

              setTimeout(() => {
                const entries = sources.map((source: string) => findEntry(source).entry);
                const totalBytes = entries.reduce(
                  (sum: number, entry: Record<string, any> | null) =>
                    sum + Number(entry?.size || 0),
                  0
                );
                const progress = {
                  processedEntries: 0,
                  totalEntries: sources.length,
                  processedBytes: 0,
                  totalBytes,
                  currentPath: sources[0] || null,
                };
                emitMockEvent('file-operation', { jobId, state: 'running', progress });

                if (cancelledJobs.has(jobId)) {
                  activeJobs.delete(jobId);
                  emitMockEvent('file-operation', { jobId, state: 'cancelled' });
                  return;
                }

                try {
                  const targets: string[] = [];
                  for (const source of sources) {
                    if (request.kind === 'trash') {
                      if (!pathExists(source)) throw new Error(`Source does not exist: ${source}`);
                      removeEntryRecursive(source);
                    } else {
                      if (typeof request.destination !== 'string') {
                        throw new Error('A destination is required');
                      }
                      const target = resolveTarget(
                        source,
                        normalizePath(request.destination),
                        String(request.conflictPolicy || 'error')
                      );
                      if (request.kind === 'copy') {
                        copyFileEntry(source, target);
                      } else if (request.kind === 'move') {
                        renameEntry(source, target);
                      } else {
                        throw new Error(`Unsupported operation: ${String(request.kind)}`);
                      }
                      targets.push(target);
                    }
                  }
                  activeJobs.delete(jobId);
                  const result = {
                    processedEntries: sources.length,
                    processedBytes: totalBytes,
                    targets,
                  };
                  emitMockEvent('file-operation', {
                    jobId,
                    state: 'completed',
                    progress: {
                      ...progress,
                      processedEntries: sources.length,
                      processedBytes: totalBytes,
                      currentPath: sources.at(-1) || null,
                    },
                    result,
                  });
                } catch (error) {
                  activeJobs.delete(jobId);
                  emitMockEvent('file-operation', {
                    jobId,
                    state: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }, 0);

              return Promise.resolve(jobId);
            }
            case 'cancel_file_operation': {
              const jobId = String(optionRecord.jobId || '');
              if (activeJobs.has(jobId)) cancelledJobs.add(jobId);
              return Promise.resolve(activeJobs.has(jobId));
            }
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
