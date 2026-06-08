/**
 * Centralized error reporting utility for consistent error handling across the app.
 *
 * This utility standardizes the error handling pattern:
 * 1. Always log to console with formatted message
 * 2. Optionally show toast notification to user
 * 3. Optionally include retry action for recoverable errors
 * 4. When error reporting is enabled, collect errors for potential submission
 *
 * Usage:
 *   import { reportError, createErrorReporter } from './errorReporter';
 *
 *   // Simple usage - logs to console only
 *   reportError('Delete failed', error);
 *
 *   // With toast notification
 *   reportError('Delete failed', error, { toast: showToast });
 *
 *   // With retry action
 *   reportError('Delete failed', error, {
 *     toast: showToast,
 *     retry: () => performDelete()
 *   });
 *
 *   // Create a scoped reporter for a component
 *   const report = createErrorReporter(showToast);
 *   report('Delete failed', error);
 */

import { formatError, type FormattedError } from './errorMessages';
import { logger } from './logger';

/**
 * Error report entry for collected errors
 */
export interface ErrorReport {
  id: string;
  timestamp: string;
  operation: string;
  error: FormattedError;
  context?: Record<string, unknown>;
  userAgent: string;
  appVersion: string;
}

/**
 * Maximum number of error reports to keep in memory
 */
const MAX_ERROR_REPORTS = 50;

/**
 * Error report collection (in-memory, cleared on app restart)
 */
const errorReports: ErrorReport[] = [];

/**
 * Generate a unique ID for error reports
 */
function generateErrorId(): string {
  return `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get the current app version from meta tag or default
 */
function getAppVersion(): string {
  try {
    // Try to get version from document meta tag
    const meta = document.querySelector('meta[name="app-version"]');
    if (meta) return meta.getAttribute('content') || 'unknown';
  } catch {}
  return 'unknown';
}

/**
 * Check if error reporting is enabled via localStorage
 * (Direct access to avoid circular dependency with store)
 */
function isErrorReportingEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('explorie:enableErrorReporting') === 'true';
    }
  } catch {}
  return false;
}

/**
 * Add an error to the collected reports
 */
function collectError(
  operation: string,
  error: FormattedError,
  context?: Record<string, unknown>
): void {
  if (!isErrorReportingEnabled()) return;

  const report: ErrorReport = {
    id: generateErrorId(),
    timestamp: new Date().toISOString(),
    operation,
    error,
    context,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    appVersion: getAppVersion(),
  };

  errorReports.unshift(report);

  // Keep only the most recent errors
  while (errorReports.length > MAX_ERROR_REPORTS) {
    errorReports.pop();
  }
}

/**
 * Get all collected error reports
 */
export function getErrorReports(): ErrorReport[] {
  return [...errorReports];
}

/**
 * Clear all collected error reports
 */
export function clearErrorReports(): void {
  errorReports.length = 0;
}

/**
 * Get the count of collected error reports
 */
export function getErrorReportCount(): number {
  return errorReports.length;
}

/**
 * Export error reports as JSON string for sharing/debugging
 */
export function exportErrorReports(): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: errorReports.length,
      reports: errorReports,
    },
    null,
    2
  );
}

type ToastFn = (
  message: string,
  options?: {
    type?: 'error' | 'warning';
    action?: { label: string; onClick: () => void };
    duration?: number;
  }
) => void;

export interface ReportOptions {
  /** Toast function to show user notification. If not provided, only logs to console. */
  toast?: ToastFn | null;
  /** Retry function for recoverable errors. Adds "Retry" button to toast. */
  retry?: () => void | Promise<void>;
  /** Custom toast duration in ms. Default: 6000 for errors, 5000 for warnings */
  duration?: number;
  /** Whether to treat as warning instead of error. Default: false */
  warning?: boolean;
  /** Additional context to include in console log */
  context?: Record<string, unknown>;
  /** Suppress console logging. Default: false */
  silent?: boolean;
}

/**
 * Report an error with consistent formatting and optional user notification.
 *
 * @param operation - Description of what failed (e.g., "Delete failed", "Move failed")
 * @param error - The error object
 * @param options - Optional configuration for toast, retry, etc.
 * @returns The formatted error for further use
 */
export function reportError(
  operation: string,
  error: unknown,
  options: ReportOptions = {}
): FormattedError {
  const formatted = formatError(error);
  const { toast, retry, duration, warning = false, context, silent = false } = options;

  // Collect error for reporting (if enabled)
  if (!warning) {
    collectError(operation, formatted, context);
  }

  // Always log using structured logger (unless silent)
  if (!silent) {
    const logContext = {
      error: formatted.technical,
      category: formatted.category,
      recoverable: formatted.recoverable,
      ...context,
    };
    if (warning) {
      logger.warn(`${operation}`, logContext);
    } else {
      logger.error(`${operation}`, logContext);
    }
  }

  // Show toast if provided
  if (toast) {
    const type = warning ? 'warning' : 'error';
    const defaultDuration = warning ? 5000 : 6000;

    const toastOptions: {
      type: 'error' | 'warning';
      action?: { label: string; onClick: () => void };
      duration: number;
    } = {
      type,
      duration: duration ?? defaultDuration,
    };

    // Add retry action for recoverable errors or if explicitly provided
    if (retry && (formatted.recoverable || options.retry)) {
      toastOptions.action = {
        label: 'Retry',
        onClick: () => {
          Promise.resolve(retry()).catch((retryError) => {
            // If retry also fails, report it (without retry to avoid infinite loop)
            reportError(`${operation} retry`, retryError, { toast, silent: true });
          });
        },
      };
      toastOptions.duration = (duration ?? defaultDuration) + 2000; // Extra time for retry button
    }

    toast(`${operation}: ${formatted.message}`, toastOptions);
  }

  return formatted;
}

/**
 * Create a scoped error reporter with pre-bound toast function.
 * Useful for components that need to report multiple errors.
 *
 * @param toast - Toast function (can be null/undefined if not available)
 * @returns A function to report errors with the bound toast
 */
export function createErrorReporter(toast?: ToastFn | null) {
  return (
    operation: string,
    error: unknown,
    options: Omit<ReportOptions, 'toast'> = {}
  ): FormattedError => {
    return reportError(operation, error, { ...options, toast });
  };
}

/**
 * Wrap an async operation with automatic error reporting.
 *
 * @param operation - Description of the operation
 * @param fn - Async function to execute
 * @param options - Error reporting options
 * @returns Result of fn, or undefined if it threw
 */
export async function withErrorReporting<T>(
  operation: string,
  fn: () => Promise<T>,
  options: ReportOptions = {}
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    reportError(operation, error, options);
    return undefined;
  }
}

/**
 * Create a wrapped version of an async function that reports errors.
 *
 * @param operation - Description of the operation
 * @param fn - Async function to wrap
 * @param options - Error reporting options
 * @returns Wrapped function
 */
export function wrapWithErrorReporting<T extends unknown[], R>(
  operation: string,
  fn: (...args: T) => Promise<R>,
  options: ReportOptions = {}
): (...args: T) => Promise<R | undefined> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (error) {
      reportError(operation, error, options);
      return undefined;
    }
  };
}

/**
 * Report a batch of errors from multiple operations.
 * Groups similar errors and shows a consolidated message.
 *
 * @param operation - Description of the batch operation
 * @param errors - Array of errors with their associated items
 * @param options - Error reporting options
 */
export function reportBatchErrors(
  operation: string,
  errors: Array<{ item: string; error: unknown }>,
  options: ReportOptions = {}
): void {
  if (errors.length === 0) return;

  const { toast, silent = false } = options;

  // Log each error using structured logger
  if (!silent) {
    for (const { item, error } of errors) {
      const formatted = formatError(error);
      logger.error(`${operation}`, {
        item,
        error: formatted.technical,
        category: formatted.category,
      });
    }
  }

  // Show consolidated toast
  if (toast) {
    const errorCount = errors.length;
    const sampleError = formatError(errors[0].error);

    let message: string;
    if (errorCount === 1) {
      message = `${operation}: ${sampleError.message}`;
    } else {
      // Group by error category
      const categories = new Map<string, number>();
      for (const { error } of errors) {
        const formatted = formatError(error);
        categories.set(formatted.category, (categories.get(formatted.category) || 0) + 1);
      }

      if (categories.size === 1) {
        message = `${operation}: ${sampleError.message} (${errorCount} items)`;
      } else {
        message = `${operation}: ${errorCount} items failed with various errors`;
      }
    }

    toast(message, {
      type: 'error',
      duration: options.duration ?? 6000,
    });
  }
}

export default {
  reportError,
  createErrorReporter,
  withErrorReporting,
  wrapWithErrorReporting,
  reportBatchErrors,
};
