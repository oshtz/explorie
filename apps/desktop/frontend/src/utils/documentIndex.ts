import { invoke } from '@tauri-apps/api/core';

export type DocumentIndexConfig = {
  includePatterns: string[];
  excludePatterns: string[];
};

export type DocumentIndexQueryResult = {
  paths: string[];
  ready: boolean;
  indexing: boolean;
};

const CONFIG_STORAGE_KEY = 'explorie:documentIndexConfig';

export const DEFAULT_DOCUMENT_INDEX_CONFIG: DocumentIndexConfig = {
  includePatterns: [],
  excludePatterns: [],
};

let configurationPromise: Promise<void> | null = null;

export function normalizeDocumentIndexPatterns(value: string): string[] {
  const patterns = value
    .split(/[\n,]/)
    .map((pattern) => pattern.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  return [...new Set(patterns)];
}

function normalizeConfig(value: unknown): DocumentIndexConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DOCUMENT_INDEX_CONFIG };
  }
  const record = value as Record<string, unknown>;
  const normalizeList = (input: unknown): string[] =>
    Array.isArray(input)
      ? normalizeDocumentIndexPatterns(input.filter((item) => typeof item === 'string').join('\n'))
      : [];
  return {
    includePatterns: normalizeList(record.includePatterns),
    excludePatterns: normalizeList(record.excludePatterns),
  };
}

export function getDocumentIndexConfig(): DocumentIndexConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_DOCUMENT_INDEX_CONFIG };
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    return raw ? normalizeConfig(JSON.parse(raw)) : { ...DEFAULT_DOCUMENT_INDEX_CONFIG };
  } catch {
    return { ...DEFAULT_DOCUMENT_INDEX_CONFIG };
  }
}

export function setDocumentIndexConfig(config: DocumentIndexConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(normalizeConfig(config)));
  } catch {
    // Settings persistence is best effort; the native index remains usable with its last config.
  }
}

async function ensureDocumentIndexConfigured(): Promise<void> {
  if (!configurationPromise) {
    const config = getDocumentIndexConfig();
    configurationPromise = invoke<void>('configure_document_index', { config }).then(
      () => undefined
    );
  }
  try {
    await configurationPromise;
  } catch (error) {
    configurationPromise = null;
    throw error;
  }
}

export async function configureDocumentIndex(config: DocumentIndexConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  setDocumentIndexConfig(normalized);
  await invoke<void>('configure_document_index', { config: normalized });
  configurationPromise = Promise.resolve();
}

export function resetDocumentIndexConfiguration(): void {
  configurationPromise = null;
}

export async function queryDocumentIndex(
  paths: string[],
  query: string
): Promise<DocumentIndexQueryResult | null> {
  if (!query.trim() || paths.length === 0) return null;
  try {
    await ensureDocumentIndexConfigured();
    const result = await invoke<DocumentIndexQueryResult>('query_document_index', {
      paths,
      query,
    });
    if (!result || !Array.isArray(result.paths)) return null;
    return {
      paths: result.paths.filter((path): path is string => typeof path === 'string'),
      ready: result.ready === true,
      indexing: result.indexing === true,
    };
  } catch {
    return null;
  }
}
