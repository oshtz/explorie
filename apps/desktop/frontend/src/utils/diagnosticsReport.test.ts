import { describe, expect, it } from 'vitest';
import {
  createDiagnosticsJson,
  createDiagnosticsReport,
  redactPathLikeText,
  summarizeErrorReports,
} from './diagnosticsReport';

describe('diagnosticsReport', () => {
  it('redacts Windows and POSIX path-like text', () => {
    expect(
      redactPathLikeText(
        String.raw`Failed at C:\Users\alex\private.txt and D:\work\explorie\secret.log`
      )
    ).toBe('Failed at [path] and [path]');

    expect(
      redactPathLikeText(
        'Failed at /Users/alex/private.txt, /home/alex/.ssh/id_rsa, /var/log/app.log, /tmp/a.txt, /private/tmp/b.txt, and /Volumes/Data/file.mov'
      )
    ).toBe('Failed at [path], [path], [path], [path], [path], and [path]');

    expect(
      redactPathLikeText('Failed at /etc/passwd and /mnt/data/secret.txt and /opt/app/config')
    ).toBe('Failed at [path] and [path] and [path]');

    const spacedPath = redactPathLikeText('Failed at /Users/alex/My Documents/file.txt');
    expect(spacedPath).toBe('Failed at [path]');
    expect(spacedPath).not.toContain('/Users/alex');
    expect(spacedPath).not.toContain('file.txt');
  });

  it('summarizes error reports without raw context or personal paths', () => {
    const summaries = summarizeErrorReports([
      {
        id: 'err-1',
        timestamp: '2026-06-06T10:00:00.000Z',
        operation: 'Open /Users/alex/private.txt',
        error: {
          category: 'filesystem',
          message: String.raw`Cannot read C:\Users\alex\private.txt`,
          technical: 'raw stack should not be included',
        },
        context: { token: 'secret-token', path: '/Users/alex/private.txt' },
      },
    ]);

    expect(summaries).toEqual([
      {
        id: 'err-1',
        timestamp: '2026-06-06T10:00:00.000Z',
        operation: 'Open [path]',
        category: 'filesystem',
        message: 'Cannot read [path]',
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain('secret-token');
    expect(JSON.stringify(summaries)).not.toContain('/Users/alex');
    expect(JSON.stringify(summaries)).not.toContain(String.raw`C:\Users\alex`);
  });

  it('creates required-field report from explicit snapshot input without personal paths', () => {
    const report = createDiagnosticsReport({
      exportedAt: '2026-06-06T11:00:00.000Z',
      app: {
        version: '1.2.3',
        gitHash: 'abc123',
        tauriRuntime: true,
        userAgent: 'TestAgent',
        platform: 'Win32',
        language: 'en-US',
      },
      fileState: {
        files: [
          {
            id: 'file-1',
            path: String.raw`C:\Users\alex\private.txt`,
            name: 'private.txt',
          },
          {
            id: 'file-2',
            path: '/Users/alex/notes.md',
            name: 'notes.md',
          },
        ],
        loading: false,
        error: String.raw`Failed to read C:\Users\alex\private.txt`,
        viewMode: 'grid',
        theme: 'light',
        pathStack: [String.raw`C:\Users\alex`, '/Users/alex/projects'],
        favorites: [{ path: '/Users/alex/favorite', name: 'favorite' }],
        activeSmartFolderId: 'smart-1',
        showHidden: true,
        showPreviewPanel: false,
        showStatusBar: true,
        clipboard: {
          mode: 'copy',
          sourcePath: String.raw`C:\Users\alex`,
          items: [{ id: 'clip-1', path: '/Users/alex/clip.txt', name: 'clip.txt' }],
        },
      },
      undoRedo: {
        undoStack: [{ id: 'undo-1' }],
        redoStack: [{ id: 'redo-1' }, { id: 'redo-2' }],
      },
      operations: {
        hasActiveOperations: true,
        operations: [
          {
            id: 'op-1',
            type: 'copy',
            status: 'failed',
            totalBytes: 200,
            processedBytes: 50,
            totalItems: 2,
            processedItems: 1,
            error: 'Failed at /mnt/data/secret.txt',
          },
        ],
      },
      disabledFeatures: [
        {
          name: 'thumbnail',
          reason: 'Disabled after reading /Users/alex/private.txt',
        },
      ],
      errorReports: [
        {
          id: 'err-1',
          timestamp: '2026-06-06T10:00:00.000Z',
          operation: 'Read /opt/app/config',
          error: {
            category: 'filesystem',
            message: 'Failure at /etc/passwd',
          },
          context: { token: 'secret-token' },
        },
      ],
    });

    expect(report).toMatchObject({
      exportedAt: '2026-06-06T11:00:00.000Z',
      app: {
        version: '1.2.3',
        gitHash: 'abc123',
        tauriRuntime: true,
        userAgent: 'TestAgent',
        platform: 'Win32',
        language: 'en-US',
      },
      fileState: {
        filesCount: 2,
        loading: false,
        error: 'Failed to read [path]',
        viewMode: 'grid',
        theme: 'light',
        pathDepth: 2,
        currentPathPresent: true,
        favoritesCount: 1,
        activeSmartFolder: true,
        showHiddenFiles: true,
        showPreviewPanel: false,
        showStatusBar: true,
        clipboard: { mode: 'copy', itemCount: 1, hasSourcePath: true },
      },
      undoRedo: { undoStackSize: 1, redoStackSize: 2 },
      operations: {
        hasActiveOperations: true,
        operationsCount: 1,
        recent: [
          {
            id: 'op-1',
            type: 'copy',
            status: 'failed',
            progress: 25,
            error: 'Failed at [path]',
          },
        ],
      },
      errors: {
        count: 1,
        recent: [
          {
            id: 'err-1',
            timestamp: '2026-06-06T10:00:00.000Z',
            operation: 'Read [path]',
            category: 'filesystem',
            message: 'Failure at [path]',
          },
        ],
      },
    });

    const json = JSON.stringify(report);
    expect(json).not.toContain(String.raw`C:\Users\alex`);
    expect(json).not.toContain('/Users/alex');
    expect(json).not.toContain('/mnt/data');
    expect(json).not.toContain('/opt/app');
    expect(json).not.toContain('/etc/passwd');
    expect(json).not.toContain('private.txt');
    expect(json).not.toContain('notes.md');
    expect(json).not.toContain('clip.txt');
    expect(json).not.toContain('secret.txt');
    expect(json).not.toContain('secret-token');
  });

  it('serializes diagnostics JSON with two-space indentation and trailing newline', () => {
    const report = createDiagnosticsReport({
      exportedAt: '2026-06-06T12:00:00.000Z',
      app: {
        version: '1.2.3',
        gitHash: 'abc123',
        tauriRuntime: false,
        userAgent: 'TestAgent',
        platform: 'MacIntel',
        language: 'en-US',
      },
      fileState: {
        files: [],
        loading: false,
        error: null,
        viewMode: 'list',
        theme: 'dark',
        pathStack: [],
        favorites: [],
        activeSmartFolderId: null,
        showHidden: false,
        showPreviewPanel: true,
        showStatusBar: true,
        clipboard: null,
      },
      undoRedo: { undoStack: [], redoStack: [] },
      operations: { hasActiveOperations: false, operations: [] },
      disabledFeatures: [],
      errorReports: [],
    });

    const json = createDiagnosticsJson(report);

    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain(
      '{\n  "exportedAt": "2026-06-06T12:00:00.000Z",\n  "app": {\n    "version": "1.2.3"'
    );
  });
});
