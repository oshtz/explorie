import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  configureDocumentIndex,
  getDocumentIndexConfig,
  normalizeDocumentIndexPatterns,
  queryDocumentIndex,
  resetDocumentIndexConfiguration,
} from './documentIndex';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('documentIndex', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDocumentIndexConfiguration();
    vi.mocked(invoke).mockReset();
  });

  it('normalizes comma and newline separated patterns', () => {
    expect(normalizeDocumentIndexPatterns(' **/*.md, **/*.txt\n**/*.md ')).toEqual([
      '**/*.md',
      '**/*.txt',
    ]);
  });

  it('configures the native index and persists the local settings', async () => {
    vi.mocked(invoke).mockResolvedValue(null);

    await configureDocumentIndex({
      includePatterns: ['**/*.md'],
      excludePatterns: ['node_modules/**'],
    });

    expect(invoke).toHaveBeenCalledWith('configure_document_index', {
      config: {
        includePatterns: ['**/*.md'],
        excludePatterns: ['node_modules/**'],
      },
    });
    expect(getDocumentIndexConfig()).toEqual({
      includePatterns: ['**/*.md'],
      excludePatterns: ['node_modules/**'],
    });
  });

  it('queries indexed paths without opening candidate files', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'configure_document_index') return null;
      return { paths: ['/docs/invoice.txt'], ready: true, indexing: false };
    });

    await expect(queryDocumentIndex(['/docs'], 'invoice 2024')).resolves.toEqual({
      paths: ['/docs/invoice.txt'],
      ready: true,
      indexing: false,
    });
    expect(invoke).toHaveBeenCalledWith('query_document_index', {
      paths: ['/docs'],
      query: 'invoice 2024',
    });
  });
});
