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

export type ErrorCategory =
  | 'permission'
  | 'not_found'
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
  /** User-friendly message */
  message: string;
  /** Error category for potential special handling */
  category: ErrorCategory;
  /** Original technical message (for debugging) */
  technical: string;
  /** Whether this error might be recoverable */
  recoverable: boolean;
  /** Suggested action for the user */
  suggestion?: string;
}

/**
 * Convert a raw error into a user-friendly error message.
 */
export function formatErrorMessage(error: unknown): string {
  return formatError(error).message;
}

/**
 * Convert a raw error into a structured FormattedError object.
 */
export function formatError(error: unknown): FormattedError {
  const technical = extractErrorMessage(error);

  if (!technical) {
    return {
      message: 'An unexpected error occurred',
      category: 'unknown',
      technical: 'Unknown error',
      recoverable: false,
    };
  }

  // Check against known patterns
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

  // If no pattern matches, try to clean up the message
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

  // Handle Tauri error objects
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
      return true;
    default:
      return false;
  }
}

/**
 * Get a helpful suggestion for an error category.
 */
function getSuggestion(category: ErrorCategory): string | undefined {
  switch (category) {
    case 'permission':
      return 'Try running as administrator or check folder permissions';
    case 'in_use':
      return 'Close any programs using the file and try again';
    case 'space':
      return 'Free up disk space and try again';
    case 'network':
      return 'Check your network connection and try again';
    case 'exists':
      return 'Rename the file or choose a different location';
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
  formatError,
  formatOperationError,
  formatBatchErrors,
  createOperationErrorMessage,
};
