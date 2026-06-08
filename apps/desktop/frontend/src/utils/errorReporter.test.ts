import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearErrorReports,
  createErrorReporter,
  exportErrorReports,
  getErrorReportCount,
  getErrorReports,
  reportBatchErrors,
  reportError,
  withErrorReporting,
  wrapWithErrorReporting,
} from './errorReporter';

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./logger', () => ({
  logger: mocks.logger,
}));

describe('errorReporter', () => {
  beforeEach(() => {
    clearErrorReports();
    localStorage.clear();
    document.head.innerHTML = '';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    mocks.logger.error.mockReset();
    mocks.logger.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs errors, collects enabled reports, and exports report JSON', () => {
    localStorage.setItem('explorie:enableErrorReporting', 'true');
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'app-version');
    meta.setAttribute('content', '1.2.3');
    document.head.appendChild(meta);

    const formatted = reportError('Delete failed', 'Permission denied', {
      context: { path: '/locked.txt' },
    });

    expect(formatted.message).toContain('Access denied');
    expect(mocks.logger.error).toHaveBeenCalledWith('Delete failed', {
      error: 'Permission denied',
      category: 'permission',
      recoverable: false,
      path: '/locked.txt',
    });
    expect(getErrorReportCount()).toBe(1);
    expect(getErrorReports()[0]).toMatchObject({
      id: 'err_1780488000000_4fzzzxj',
      timestamp: '2026-06-03T12:00:00.000Z',
      operation: 'Delete failed',
      appVersion: '1.2.3',
      context: { path: '/locked.txt' },
    });

    const exported = JSON.parse(exportErrorReports()) as {
      exportedAt: string;
      count: number;
      reports: unknown[];
    };
    expect(exported.exportedAt).toBe('2026-06-03T12:00:00.000Z');
    expect(exported.count).toBe(1);
    expect(exported.reports).toHaveLength(1);
  });

  it('shows warning toasts without collecting reports or error logs', () => {
    localStorage.setItem('explorie:enableErrorReporting', 'true');
    const toast = vi.fn();

    reportError('Preview warning', new Error('File is being used'), {
      toast,
      warning: true,
      duration: 1234,
    });

    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(getErrorReportCount()).toBe(0);
    expect(toast).toHaveBeenCalledWith('Preview warning: The file is in use by another program', {
      type: 'warning',
      duration: 1234,
    });
  });

  it('adds retry actions for recoverable errors and reports retry failures silently', async () => {
    const toast = vi.fn();
    const retry = vi.fn(async () => {
      throw new Error('still busy');
    });

    reportError('Move failed', 'File is being used by another process', { toast, retry });

    const toastOptions = toast.mock.calls[0][1] as {
      duration: number;
      action: { label: string; onClick: () => void };
    };
    expect(toastOptions.duration).toBe(8000);
    expect(toastOptions.action.label).toBe('Retry');

    toastOptions.action.onClick();
    await Promise.resolve();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it('creates scoped reporters and wraps async operations', async () => {
    const toast = vi.fn();
    const scopedReport = createErrorReporter(toast);

    scopedReport('Scoped failure', 'Disk full', { silent: true });

    expect(toast).toHaveBeenCalledWith('Scoped failure: Not enough disk space', {
      type: 'error',
      duration: 6000,
    });
    expect(mocks.logger.error).not.toHaveBeenCalled();

    await expect(withErrorReporting('Load data', async () => 'ok')).resolves.toBe('ok');
    await expect(
      withErrorReporting('Load data', async () => {
        throw new Error('Cannot find path');
      })
    ).resolves.toBeUndefined();

    const wrapped = wrapWithErrorReporting('Save data', async (value: string) => {
      if (value === 'bad') throw new Error('Permission denied');
      return value.toUpperCase();
    });

    await expect(wrapped('good')).resolves.toBe('GOOD');
    await expect(wrapped('bad')).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest collected reports', () => {
    localStorage.setItem('explorie:enableErrorReporting', 'true');

    for (let i = 0; i < 55; i += 1) {
      reportError(`Operation ${i}`, new Error(`Failure ${i}`), { silent: true });
    }

    expect(getErrorReportCount()).toBe(50);
    expect(getErrorReports()[0].operation).toBe('Operation 54');
    expect(getErrorReports().at(-1)?.operation).toBe('Operation 5');
  });

  it('reports batch errors with consolidated toast messages', () => {
    const toast = vi.fn();

    reportBatchErrors('Copy failed', [], { toast });
    expect(toast).not.toHaveBeenCalled();

    reportBatchErrors('Copy failed', [{ item: 'a.txt', error: 'Permission denied' }], { toast });
    expect(toast).toHaveBeenLastCalledWith(
      "Copy failed: Access denied - you don't have permission for this operation",
      { type: 'error', duration: 6000 }
    );

    reportBatchErrors(
      'Copy failed',
      [
        { item: 'a.txt', error: 'Permission denied' },
        { item: 'b.txt', error: 'Permission denied' },
      ],
      { toast, duration: 2500 }
    );
    expect(toast).toHaveBeenLastCalledWith(
      "Copy failed: Access denied - you don't have permission for this operation (2 items)",
      { type: 'error', duration: 2500 }
    );

    reportBatchErrors(
      'Copy failed',
      [
        { item: 'a.txt', error: 'Permission denied' },
        { item: 'b.txt', error: 'File not found' },
      ],
      { toast, silent: true }
    );
    expect(toast).toHaveBeenLastCalledWith('Copy failed: 2 items failed with various errors', {
      type: 'error',
      duration: 6000,
    });
  });

  it('clears reports and skips collection when reporting is disabled', () => {
    reportError('Read failed', 'File not found', { silent: true });
    expect(getErrorReportCount()).toBe(0);

    localStorage.setItem('explorie:enableErrorReporting', 'true');
    reportError('Read failed', 'File not found', { silent: true });
    expect(getErrorReportCount()).toBe(1);

    clearErrorReports();
    expect(getErrorReports()).toEqual([]);
  });
});
