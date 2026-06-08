import { useOperationQueueStore } from '../operationQueueStore';
import { isTauriRuntime } from '../services/updater';
import { useFileStore } from '../store';
import { useUndoRedoStore } from '../undoRedoStore';
import { getErrorReports } from './errorReporter';
import { getDisabledFeatures } from './featureFallback';

const RECENT_LIMIT = 10;
const UNKNOWN = 'unknown';

type JsonRecord = Record<string, unknown>;

type ClipboardSnapshot = {
  mode?: unknown;
  items?: unknown;
  sourcePath?: unknown;
} | null;

type FileStateSnapshot = {
  files?: unknown;
  loading?: unknown;
  error?: unknown;
  viewMode?: unknown;
  theme?: unknown;
  pathStack?: unknown;
  currentPath?: unknown;
  favorites?: unknown;
  activeSmartFolderId?: unknown;
  showHidden?: unknown;
  showHiddenFiles?: unknown;
  showPreviewPanel?: unknown;
  showStatusBar?: unknown;
  clipboard?: ClipboardSnapshot;
};

type UndoRedoSnapshot = {
  undoStack?: unknown;
  redoStack?: unknown;
};

type OperationSnapshot = {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  progress?: unknown;
  totalBytes?: unknown;
  processedBytes?: unknown;
  totalItems?: unknown;
  processedItems?: unknown;
  error?: unknown;
};

type OperationsSnapshot = {
  hasActiveOperations?: unknown;
  operations?: unknown;
};

export interface DiagnosticsInput {
  exportedAt?: string;
  app?: Partial<DiagnosticsReport['app']>;
  fileState?: FileStateSnapshot;
  undoRedo?: UndoRedoSnapshot;
  operations?: OperationsSnapshot;
  disabledFeatures?: Array<Record<string, unknown>>;
  errorReports?: Array<Record<string, unknown>>;
}

export interface DiagnosticsReport {
  exportedAt: string;
  app: {
    version: string;
    gitHash: string;
    tauriRuntime: boolean;
    userAgent: string;
    platform: string;
    language: string;
  };
  fileState: {
    filesCount: number;
    loading: boolean;
    error: string | null;
    viewMode: string;
    theme: string;
    pathDepth: number;
    currentPathPresent: boolean;
    favoritesCount: number;
    activeSmartFolder: boolean;
    showHiddenFiles: boolean;
    showPreviewPanel: boolean;
    showStatusBar: boolean;
    clipboard: { mode: string; itemCount: number; hasSourcePath: boolean } | null;
  };
  undoRedo: {
    undoStackSize: number;
    redoStackSize: number;
  };
  operations: {
    hasActiveOperations: boolean;
    operationsCount: number;
    recent: Array<{
      id: string;
      type: string;
      status: string;
      progress: number;
      error: string | null;
    }>;
  };
  disabledFeatures: Array<{ name: string; reason: string }>;
  errors: {
    count: number;
    recent: Array<{
      id: string;
      timestamp: string;
      operation: string;
      category: string;
      message: string;
    }>;
  };
}

const WINDOWS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\/\s:*?"<>|]+\\)*[^\\/\s:*?"<>|,;:!?)]*/g;

export function redactPathLikeText(value: string): string {
  return redactPosixPathLikeText(value.replace(WINDOWS_PATH_RE, '[path]'));
}

export function summarizeErrorReports(
  reports?: Record<string, unknown>[]
): Array<{ id: string; timestamp: string; operation: string; category: string; message: string }> {
  if (!Array.isArray(reports)) return [];

  return reports.map((report) => {
    const error = isRecord(report.error) ? report.error : {};
    return {
      id: sanitizeString(readString(report.id)),
      timestamp: sanitizeString(readString(report.timestamp)),
      operation: sanitizeString(readString(report.operation)),
      category: sanitizeString(readString(error.category ?? report.category)),
      message: sanitizeString(readString(error.message ?? report.message)),
    };
  });
}

export function createDiagnosticsReport(input?: DiagnosticsInput): DiagnosticsReport {
  const fileState = input?.fileState ?? useFileStore.getState();
  const undoRedo = input?.undoRedo ?? useUndoRedoStore.getState();
  const operationState = input?.operations ?? useOperationQueueStore.getState();
  const errorReports = input?.errorReports ?? getErrorReports();
  const errorReportRecords = Array.isArray(errorReports) ? errorReports.filter(isRecord) : [];
  const disabledFeatures = input?.disabledFeatures ?? getDisabledFeatures();

  return {
    exportedAt: input?.exportedAt ?? new Date().toISOString(),
    app: createAppSummary(input?.app),
    fileState: createFileStateSummary(fileState),
    undoRedo: {
      undoStackSize: getArrayLength(undoRedo.undoStack),
      redoStackSize: getArrayLength(undoRedo.redoStack),
    },
    operations: createOperationsSummary(operationState),
    disabledFeatures: summarizeDisabledFeatures(disabledFeatures),
    errors: {
      count: Array.isArray(errorReports) ? errorReports.length : 0,
      recent: summarizeErrorReports(errorReportRecords.slice(0, RECENT_LIMIT)),
    },
  };
}

export function createDiagnosticsJson(
  report: DiagnosticsReport = createDiagnosticsReport()
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function copyDiagnosticsJson(
  writeText?: (value: string) => Promise<void>
): Promise<string> {
  const json = createDiagnosticsJson();
  const writer = writeText ?? getClipboardWriter();
  if (!writer) {
    throw new Error('Clipboard API is unavailable.');
  }

  await writer(json);
  return json;
}

export function downloadDiagnosticsJson(): string {
  const json = createDiagnosticsJson();

  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return json;
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `explorie-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  return json;
}

function createAppSummary(app?: Partial<DiagnosticsReport['app']>): DiagnosticsReport['app'] {
  return {
    version: readOptionalString(app?.version) ?? readBuildVersion(),
    gitHash: readOptionalString(app?.gitHash) ?? readGitHash(),
    tauriRuntime: typeof app?.tauriRuntime === 'boolean' ? app.tauriRuntime : safeIsTauriRuntime(),
    userAgent: readOptionalString(app?.userAgent) ?? readNavigatorValue('userAgent'),
    platform: readOptionalString(app?.platform) ?? readNavigatorValue('platform'),
    language: readOptionalString(app?.language) ?? readNavigatorValue('language'),
  };
}

function createFileStateSummary(fileState: FileStateSnapshot): DiagnosticsReport['fileState'] {
  const pathStackLength = getArrayLength(fileState.pathStack);
  const currentPathPresent = isNonEmptyString(fileState.currentPath) || pathStackLength > 0;
  return {
    filesCount: getArrayLength(fileState.files),
    loading: fileState.loading === true,
    error: isNonEmptyString(fileState.error) ? sanitizeString(fileState.error) : null,
    viewMode: sanitizeString(readString(fileState.viewMode)),
    theme: sanitizeString(readString(fileState.theme)),
    pathDepth: pathStackLength,
    currentPathPresent,
    favoritesCount: getArrayLength(fileState.favorites),
    activeSmartFolder: isNonEmptyString(fileState.activeSmartFolderId),
    showHiddenFiles: fileState.showHiddenFiles === true || fileState.showHidden === true,
    showPreviewPanel: fileState.showPreviewPanel === true,
    showStatusBar: fileState.showStatusBar === true,
    clipboard: summarizeClipboard(fileState.clipboard ?? null),
  };
}

function summarizeClipboard(
  clipboard: ClipboardSnapshot
): DiagnosticsReport['fileState']['clipboard'] {
  if (!isRecord(clipboard)) return null;
  return {
    mode: sanitizeString(readString(clipboard.mode)),
    itemCount: getArrayLength(clipboard.items),
    hasSourcePath: isNonEmptyString(clipboard.sourcePath),
  };
}

function createOperationsSummary(
  operationState: OperationsSnapshot
): DiagnosticsReport['operations'] {
  const operations = Array.isArray(operationState.operations)
    ? (operationState.operations as OperationSnapshot[])
    : [];
  return {
    hasActiveOperations: readHasActiveOperations(operationState, operations),
    operationsCount: operations.length,
    recent: operations.slice(-RECENT_LIMIT).map((operation) => ({
      id: sanitizeString(readString(operation.id)),
      type: sanitizeString(readString(operation.type)),
      status: sanitizeString(readString(operation.status)),
      progress: calculateProgress(operation),
      error: isNonEmptyString(operation.error) ? sanitizeString(operation.error) : null,
    })),
  };
}

function summarizeDisabledFeatures(
  disabledFeatures: Array<Record<string, unknown>>
): DiagnosticsReport['disabledFeatures'] {
  return disabledFeatures.map((feature) => ({
    name: sanitizeString(readString(feature.name)),
    reason: sanitizeString(readString(feature.reason)),
  }));
}

function readHasActiveOperations(
  operationState: OperationsSnapshot,
  operations: OperationSnapshot[]
): boolean {
  if (typeof operationState.hasActiveOperations === 'function') {
    try {
      return operationState.hasActiveOperations() === true;
    } catch {
      return false;
    }
  }
  if (typeof operationState.hasActiveOperations === 'boolean') {
    return operationState.hasActiveOperations;
  }
  return operations.some((operation) =>
    ['pending', 'running', 'paused'].includes(readString(operation.status))
  );
}

function calculateProgress(operation: OperationSnapshot): number {
  const explicit = readNumber(operation.progress);
  if (explicit != null) return clampProgress(explicit);

  const totalBytes = readNumber(operation.totalBytes);
  const processedBytes = readNumber(operation.processedBytes);
  if (totalBytes && totalBytes > 0 && processedBytes != null) {
    return clampProgress((processedBytes / totalBytes) * 100);
  }

  const totalItems = readNumber(operation.totalItems);
  const processedItems = readNumber(operation.processedItems);
  if (totalItems && totalItems > 0 && processedItems != null) {
    return clampProgress((processedItems / totalItems) * 100);
  }

  return 0;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readBuildVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function readGitHash(): string {
  try {
    return typeof __GIT_HASH__ === 'string' && __GIT_HASH__ ? __GIT_HASH__ : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function safeIsTauriRuntime(): boolean {
  try {
    return isTauriRuntime();
  } catch {
    return false;
  }
}

function readNavigatorValue(key: 'userAgent' | 'platform' | 'language'): string {
  try {
    if (typeof navigator !== 'undefined') {
      return navigator[key] || UNKNOWN;
    }
  } catch {}
  return UNKNOWN;
}

function getClipboardWriter(): ((value: string) => Promise<void>) | null {
  if (
    typeof navigator === 'undefined' ||
    !navigator.clipboard ||
    typeof navigator.clipboard.writeText !== 'function'
  ) {
    return null;
  }
  return (value: string) => navigator.clipboard.writeText(value);
}

function sanitizeString(value: string): string {
  return redactPathLikeText(value);
}

function redactPosixPathLikeText(value: string): string {
  let redacted = '';
  let index = 0;

  while (index < value.length) {
    if (!isPosixPathStart(value, index)) {
      redacted += value[index];
      index += 1;
      continue;
    }

    const end = findPosixPathEnd(value, index);
    redacted += '[path]';
    index = end;
  }

  return redacted;
}

function isPosixPathStart(value: string, index: number): boolean {
  if (value[index] !== '/') return false;

  const previous = value[index - 1];
  if (previous && !isPosixPathBoundary(previous)) return false;

  const next = value[index + 1];
  return Boolean(next && next !== '/' && !isPosixPathTerminator(next) && !/\s/.test(next));
}

function isPosixPathBoundary(value: string): boolean {
  return (
    /\s/.test(value) ||
    value === '"' ||
    value === "'" ||
    value === '(' ||
    value === '[' ||
    value === '{' ||
    value === '='
  );
}

function findPosixPathEnd(value: string, start: number): number {
  let index = start;

  while (index < value.length) {
    const current = value[index];
    if (isPosixPathTerminator(current)) break;
    if (current === ' ' && !spaceContinuesPosixPath(value, index)) break;
    index += 1;
  }

  while (index > start && '.!?'.includes(value[index - 1])) {
    index -= 1;
  }

  return index;
}

function isPosixPathTerminator(value: string): boolean {
  return (
    value === '\r' ||
    value === '\n' ||
    value === '\t' ||
    value === '"' ||
    value === "'" ||
    value === '<' ||
    value === '>' ||
    value === '|' ||
    value === ',' ||
    value === ';' ||
    value === ':' ||
    value === ')' ||
    value === ']' ||
    value === '}'
  );
}

function spaceContinuesPosixPath(value: string, spaceIndex: number): boolean {
  for (let index = spaceIndex + 1; index < value.length; index += 1) {
    const current = value[index];
    if (current === '/') return true;
    if (current === ' ' || isPosixPathTerminator(current)) return false;
  }
  return false;
}

function readString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return UNKNOWN;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return sanitizeString(value);
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
