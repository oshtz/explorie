/**
 * Centralized error message formatting for user-friendly error display.
 * Converts technical error messages into human-readable text.
 */

// Common error patterns mapped to user-friendly messages
const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string; category: ErrorCategory }> = [
  // Permission errors
  {
    pattern: /(access is denied|permission denied|eacces|eperm)/i,
    message: "Access denied - you don't have permission for this operation",
    category: 'permission',
  },
  {
    pattern: /(readonly|read.only)/i,
    message: 'This location is read-only',
    category: 'permission',
  },

  // Not found errors
  {
    pattern: /(no such file|cannot find|not found|os error 2|enoent)/i,
    message: 'File or folder not found',
    category: 'not_found',
  },
  {
    pattern: /(path does not exist)/i,
    message: 'The path no longer exists',
    category: 'not_found',
  },

  // File type errors
  {
    pattern: /(not a directory|enotdir)/i,
    message: 'Expected a folder but found a file',
    category: 'type',
  },
  {
    pattern: /(is a directory|eisdir)/i,
    message: 'Expected a file but found a folder',
    category: 'type',
  },

  // In-use errors
  {
    pattern: /(file is being used|used by another process|sharing violation|ebusy)/i,
    message: 'The file is in use by another program',
    category: 'in_use',
  },
  { pattern: /(locked|elocked)/i, message: 'The file is locked', category: 'in_use' },

  // Space errors
  {
    pattern: /(disk full|no space|enospc|not enough space)/i,
    message: 'Not enough disk space',
    category: 'space',
  },
  { pattern: /(quota exceeded)/i, message: 'Storage quota exceeded', category: 'space' },

  // Name errors
  {
    pattern: /(invalid file name|invalid name|illegal character)/i,
    message: 'The file name contains invalid characters',
    category: 'name',
  },
  {
    pattern: /(file exists|already exists|eexist)/i,
    message: 'A file with this name already exists',
    category: 'exists',
  },
  {
    pattern: /(name too long|enametoolong)/i,
    message: 'The file name is too long',
    category: 'name',
  },

  // Network errors
  {
    pattern: /(network|connection refused|econnrefused|host unreachable)/i,
    message: 'Network connection failed',
    category: 'network',
  },
  {
    pattern: /(timeout|timed out|etimedout)/i,
    message: 'The operation timed out',
    category: 'network',
  },

  // Archive errors
  {
    pattern: /(invalid archive|corrupted archive|bad archive)/i,
    message: 'The archive file is corrupted or invalid',
    category: 'archive',
  },
  {
    pattern: /(password.*incorrect|wrong password|invalid password)/i,
    message: 'Incorrect archive password',
    category: 'archive',
  },
  {
    pattern: /(unsupported.*format|unknown.*format)/i,
    message: 'Unsupported archive format',
    category: 'archive',
  },

  // Path errors
  {
    pattern: /(path.*too long|pathname too long)/i,
    message: 'The file path is too long',
    category: 'path',
  },
  { pattern: /(invalid path|malformed path)/i, message: 'Invalid file path', category: 'path' },
  {
    pattern: /(traversal|\.\.)/i,
    message: 'Invalid path - cannot navigate outside allowed directories',
    category: 'path',
  },

  // System errors
  {
    pattern: /(too many open files|emfile)/i,
    message: 'Too many files are open - try closing some applications',
    category: 'system',
  },
  {
    pattern: /(operation not permitted|eperm)/i,
    message: 'This operation is not permitted',
    category: 'system',
  },
  {
    pattern: /(cross.device|exdev)/i,
    message: 'Cannot move files between different drives this way',
    category: 'system',
  },
];

export type AppErrorCode =
  | 'permission'
  | 'missing_path'
  | 'conflict'
  | 'cancelled'
  | 'helper_missing'
  | 'remote_unavailable'
  | 'invalid_name'
  | 'in_use'
  | 'disk_full'
  | 'archive'
  | 'path'
  | 'type_mismatch'
  | 'unsupported'
  | 'unknown';

export interface AppErrorPayload {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  operation?: string;
  detail?: string;
}

export type ErrorCategory =
  | 'permission'
  | 'not_found'
  | 'missing_path'
  | 'conflict'
  | 'cancelled'
  | 'helper_missing'
  | 'remote_unavailable'
  | 'type'
  | 'in_use'
  | 'space'
  | 'name'
  | 'exists'
  | 'network'
  | 'archive'
  | 'path'
  | 'system'
  | 'unknown';

export interface FormattedError {
  message: string;
  category: ErrorCategory;
  technical: string;
  recoverable: boolean;
  suggestion?: string;
  code?: AppErrorCode;
  operation?: string;
}

const APP_ERROR_CODES = new Set<AppErrorCode>([
  'permission',
  'missing_path',
  'conflict',
  'cancelled',
  'helper_missing',
  'remote_unavailable',
  'invalid_name',
  'in_use',
  'disk_full',
  'archive',
  'path',
  'type_mismatch',
  'unsupported',
  'unknown',
]);

export function isAppErrorPayload(error: unknown): error is AppErrorPayload {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const value = error as Record<string, unknown>;
  return (
    typeof value.code === 'string' &&
    APP_ERROR_CODES.has(value.code as AppErrorCode) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

/**
 * Convert a raw error into a user-friendly error message.
 */
export function formatErrorMessage(error: unknown): string {
  return formatError(error).message;
}

export function formatUserFacingError(error: unknown): string {
  const formatted = formatError(error);
  return formatted.suggestion ? `${formatted.message}. ${formatted.suggestion}` : formatted.message;
}

export function persistInvokeError(error: unknown): AppErrorPayload | string {
  return extractAppError(error) ?? formatUserFacingError(error);
}

export function toStructuredError(error: unknown): Error {
  if (error instanceof Error && isAppErrorPayload(error)) {
    return error;
  }

  const formatted = formatError(error);
  const next = new Error(formatted.message) as Error & Partial<AppErrorPayload>;
  if (formatted.code) {
    next.code = formatted.code;
    next.retryable = formatted.recoverable;
    if (formatted.operation) {
      next.operation = formatted.operation;
    }
    if (formatted.technical && formatted.technical !== formatted.message) {
      next.detail = formatted.technical;
    }
  }
  return next;
}

/**
 * Convert a raw error into a structured FormattedError object.
 */
export function formatError(error: unknown): FormattedError {
  const structured = extractAppError(error);
  if (structured) {
    const category = categoryFromCode(structured.code);
    return {
      message: structured.message,
      category,
      technical: structured.detail || structured.message,
      recoverable: structured.retryable,
      suggestion: getSuggestion(category),
      code: structured.code,
      operation: structured.operation,
    };
  }

  const technical = extractErrorMessage(error);

  if (!technical) {
    return {
      message: 'An unexpected error occurred',
      category: 'unknown',
      technical: 'Unknown error',
      recoverable: false,
    };
  }

  for (const { pattern, message, category } of ERROR_PATTERNS) {
    if (pattern.test(technical)) {
      return {
        message,
        category,
        technical,
        recoverable: isRecoverable(category),
        suggestion: getSuggestion(category),
      };
    }
  }

  return {
    message: cleanupTechnicalMessage(technical),
    category: 'unknown',
    technical,
    recoverable: false,
  };
}

/**
 * Format an error for display in a toast notification.
 * Includes the operation context (e.g., "Failed to copy: Access denied")
 */
export function formatOperationError(operation: string, error: unknown): string {
  const formatted = formatError(error);
  return `${operation}: ${formatted.message}`;
}

/**
 * Format multiple errors (e.g., from batch operations).
 */
export function formatBatchErrors(
  errors: Array<{ path: string; error: unknown }>,
  maxDisplay = 3
): string {
  if (errors.length === 0) return '';

  const formatted = errors.map((e) => ({
    path: getFileName(e.path),
    error: formatError(e.error),
  }));

  // Group by error category
  const byCategory = new Map<ErrorCategory, string[]>();
  for (const { path, error } of formatted) {
    const paths = byCategory.get(error.category) || [];
    paths.push(path);
    byCategory.set(error.category, paths);
  }

  // Build summary message
  if (byCategory.size === 1) {
    // All errors are the same type
    const [, paths] = [...byCategory.entries()][0];
    const sampleError = formatted[0].error;
    if (paths.length === 1) {
      return `"${paths[0]}": ${sampleError.message}`;
    }
    if (paths.length <= maxDisplay) {
      return `${sampleError.message}: ${paths.map((p) => `"${p}"`).join(', ')}`;
    }
    return `${sampleError.message} (${paths.length} items)`;
  }

  // Multiple error types
  const summaryParts: string[] = [];
  for (const [category, paths] of byCategory) {
    const sampleError = formatted.find((f) => f.error.category === category)?.error;
    if (sampleError) {
      summaryParts.push(
        `${paths.length} ${paths.length === 1 ? 'item' : 'items'}: ${sampleError.message}`
      );
    }
  }

  return summaryParts.join('; ');
}

/**
 * Extract the error message string from various error types.
 */
function extractAppError(error: unknown): AppErrorPayload | null {
  if (isAppErrorPayload(error)) {
    return error;
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"code"')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isAppErrorPayload(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  if (error instanceof Error && error.message.trim().startsWith('{')) {
    return extractAppError(error.message);
  }

  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (isAppErrorPayload(obj.error)) {
      return obj.error;
    }
    if (isAppErrorPayload(obj.data)) {
      return obj.data;
    }
  }

  return null;
}

function categoryFromCode(code: AppErrorCode): ErrorCategory {
  switch (code) {
    case 'permission':
      return 'permission';
    case 'missing_path':
      return 'missing_path';
    case 'conflict':
      return 'conflict';
    case 'cancelled':
      return 'cancelled';
    case 'helper_missing':
      return 'helper_missing';
    case 'remote_unavailable':
      return 'remote_unavailable';
    case 'invalid_name':
      return 'name';
    case 'in_use':
      return 'in_use';
    case 'disk_full':
      return 'space';
    case 'archive':
      return 'archive';
    case 'path':
      return 'path';
    case 'type_mismatch':
      return 'type';
    case 'unsupported':
      return 'system';
    default:
      return 'unknown';
  }
}

function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.msg === 'string') return obj.msg;
  }

  // Fallback to string conversion
  try {
    const str = String(error);
    if (str !== '[object Object]') {
      return str;
    }
  } catch {}

  return '';
}

/**
 * Clean up a technical message that didn't match any pattern.
 * Removes stack traces, file paths, and other technical details.
 */
function cleanupTechnicalMessage(message: string): string {
  let cleaned = message;

  // Remove stack traces
  cleaned = cleaned.replace(/\n\s*at\s+.+/g, '');

  // Remove common prefixes
  cleaned = cleaned.replace(/^(error|exception|failed|unable to):\s*/i, '');

  // Remove file paths (but keep filename)
  cleaned = cleaned.replace(/[A-Z]:\\[^\s:]+\\([^\\:]+)/gi, '"$1"');
  cleaned = cleaned.replace(/\/[^\s:]+\/([^/:]+)/g, '"$1"');

  // Remove OS error codes
  cleaned = cleaned.replace(/\s*\(os error \d+\)/gi, '');

  // Capitalize first letter
  cleaned = cleaned.trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // Ensure it ends with proper punctuation or nothing
  cleaned = cleaned.replace(/[.!?]+$/, '');

  return cleaned || 'An error occurred';
}

/**
 * Determine if an error category is potentially recoverable.
 */
function isRecoverable(category: ErrorCategory): boolean {
  switch (category) {
    case 'in_use':
    case 'network':
    case 'space':
    case 'cancelled':
    case 'helper_missing':
    case 'remote_unavailable':
      return true;
    default:
      return false;
  }
}

function getSuggestion(category: ErrorCategory): string | undefined {
  switch (category) {
    case 'permission':
      return 'Check folder permissions, then try a different location';
    case 'missing_path':
    case 'not_found':
      return 'Refresh the view and confirm the item still exists';
    case 'conflict':
    case 'exists':
      return 'Rename the item or choose a different destination';
    case 'cancelled':
      return 'Run the operation again if you still need it';
    case 'helper_missing':
      return 'Install or approve the required helper, then retry';
    case 'remote_unavailable':
      return 'Check the remote connection and retry';
    case 'in_use':
      return 'Close any programs using the file and try again';
    case 'space':
      return 'Free up disk space and try again';
    case 'network':
      return 'Check your network connection and try again';
    case 'name':
      return 'Try a different file name without special characters';
    default:
      return undefined;
  }
}

/**
 * Extract just the filename from a path.
 */
function getFileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Create a standard error message for operation failures.
 */
export function createOperationErrorMessage(
  operationType: 'copy' | 'move' | 'delete' | 'rename' | 'create' | 'compress' | 'extract',
  error: unknown,
  itemName?: string
): string {
  const formatted = formatError(error);
  const operationVerb = {
    copy: 'copy',
    move: 'move',
    delete: 'delete',
    rename: 'rename',
    create: 'create',
    compress: 'compress',
    extract: 'extract',
  }[operationType];

  if (itemName) {
    return `Failed to ${operationVerb} "${itemName}": ${formatted.message}`;
  }
  return `Failed to ${operationVerb}: ${formatted.message}`;
}

export default {
  formatErrorMessage,
  formatUserFacingError,
  persistInvokeError,
  toStructuredError,
  formatError,
  formatOperationError,
  formatBatchErrors,
  createOperationErrorMessage,
};
