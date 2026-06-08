import { describe, it, expect } from 'vitest';
import {
  formatErrorMessage,
  formatError,
  formatOperationError,
  formatBatchErrors,
  createOperationErrorMessage,
  type FormattedError,
} from './errorMessages';

describe('errorMessages', () => {
  describe('formatErrorMessage', () => {
    it('handles null/undefined gracefully', () => {
      expect(formatErrorMessage(null)).toBe('An unexpected error occurred');
      expect(formatErrorMessage(undefined)).toBe('An unexpected error occurred');
    });

    it('handles string errors', () => {
      expect(formatErrorMessage('Something went wrong')).toBe('Something went wrong');
    });

    it('handles Error objects', () => {
      expect(formatErrorMessage(new Error('Test error'))).toBe('Test error');
    });

    it('converts permission denied to user-friendly message', () => {
      expect(formatErrorMessage('Access is denied')).toBe(
        "Access denied - you don't have permission for this operation"
      );
      expect(formatErrorMessage('Permission denied')).toBe(
        "Access denied - you don't have permission for this operation"
      );
      expect(formatErrorMessage('EACCES: permission denied')).toBe(
        "Access denied - you don't have permission for this operation"
      );
      expect(formatErrorMessage(new Error('EPERM: operation not permitted'))).toBe(
        "Access denied - you don't have permission for this operation"
      );
    });

    it('converts not found errors to user-friendly message', () => {
      expect(formatErrorMessage('No such file or directory')).toBe('File or folder not found');
      expect(formatErrorMessage('Cannot find path')).toBe('File or folder not found');
      expect(formatErrorMessage('ENOENT: not found')).toBe('File or folder not found');
      expect(formatErrorMessage('os error 2')).toBe('File or folder not found');
    });

    it('converts file type errors', () => {
      expect(formatErrorMessage('Not a directory')).toBe('Expected a folder but found a file');
      expect(formatErrorMessage('Is a directory')).toBe('Expected a file but found a folder');
    });

    it('converts in-use errors', () => {
      expect(formatErrorMessage('The file is being used by another process')).toBe(
        'The file is in use by another program'
      );
      expect(formatErrorMessage('Sharing violation')).toBe('The file is in use by another program');
    });

    it('converts disk space errors', () => {
      expect(formatErrorMessage('Disk full')).toBe('Not enough disk space');
      expect(formatErrorMessage('ENOSPC: no space left')).toBe('Not enough disk space');
    });

    it('converts name errors', () => {
      expect(formatErrorMessage('Invalid file name')).toBe(
        'The file name contains invalid characters'
      );
      expect(formatErrorMessage('File exists')).toBe('A file with this name already exists');
      expect(formatErrorMessage('Name too long')).toBe('The file name is too long');
    });

    it('converts archive errors', () => {
      expect(formatErrorMessage('Invalid archive')).toBe(
        'The archive file is corrupted or invalid'
      );
      expect(formatErrorMessage('Password incorrect')).toBe('Incorrect archive password');
      expect(formatErrorMessage('Unsupported format')).toBe('Unsupported archive format');
    });

    it('converts network errors', () => {
      expect(formatErrorMessage('Connection refused')).toBe('Network connection failed');
      expect(formatErrorMessage('Request timed out')).toBe('The operation timed out');
    });

    it('cleans up technical messages that do not match patterns', () => {
      // Should capitalize first letter
      const result = formatErrorMessage('some random error');
      expect(result.charAt(0)).toBe('S');
    });
  });

  describe('formatError', () => {
    it('returns structured FormattedError object', () => {
      const result = formatError('Access is denied');
      expect(result).toMatchObject({
        message: "Access denied - you don't have permission for this operation",
        category: 'permission',
        technical: 'Access is denied',
        recoverable: false,
      });
      expect(result.suggestion).toBeDefined();
    });

    it('identifies recoverable errors', () => {
      const inUseError = formatError('File is being used by another process');
      expect(inUseError.recoverable).toBe(true);

      const networkError = formatError('Connection refused');
      expect(networkError.recoverable).toBe(true);

      const spaceError = formatError('Disk full');
      expect(spaceError.recoverable).toBe(true);

      const permError = formatError('Permission denied');
      expect(permError.recoverable).toBe(false);
    });

    it('provides helpful suggestions', () => {
      const permError = formatError('Permission denied');
      expect(permError.suggestion).toContain('permission');

      const inUseError = formatError('File is being used');
      expect(inUseError.suggestion).toContain('Close');

      const spaceError = formatError('No space');
      expect(spaceError.suggestion).toContain('space');
    });
  });

  describe('formatOperationError', () => {
    it('combines operation name with error message', () => {
      expect(formatOperationError('Copy', 'Permission denied')).toBe(
        "Copy: Access denied - you don't have permission for this operation"
      );
    });
  });

  describe('createOperationErrorMessage', () => {
    it('creates error messages for different operation types', () => {
      expect(createOperationErrorMessage('copy', 'Permission denied', 'test.txt')).toBe(
        `Failed to copy "test.txt": Access denied - you don't have permission for this operation`
      );
      expect(createOperationErrorMessage('delete', 'File not found')).toBe(
        'Failed to delete: File or folder not found'
      );
    });
  });

  describe('formatBatchErrors', () => {
    it('handles empty array', () => {
      expect(formatBatchErrors([])).toBe('');
    });

    it('formats single error with path', () => {
      const errors = [{ path: '/path/to/file.txt', error: 'Permission denied' }];
      expect(formatBatchErrors(errors)).toContain('file.txt');
    });

    it('groups errors by category and lists items when under maxDisplay', () => {
      const errors = [
        { path: '/a/file1.txt', error: 'Permission denied' },
        { path: '/b/file2.txt', error: 'Permission denied' },
        { path: '/c/file3.txt', error: 'Permission denied' },
      ];
      const result = formatBatchErrors(errors);
      // When 3 items (equal to maxDisplay), it lists them all
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
      expect(result).toContain('file3.txt');
    });

    it('shows count when over maxDisplay', () => {
      const errors = [
        { path: '/a/file1.txt', error: 'Permission denied' },
        { path: '/b/file2.txt', error: 'Permission denied' },
        { path: '/c/file3.txt', error: 'Permission denied' },
        { path: '/d/file4.txt', error: 'Permission denied' },
      ];
      const result = formatBatchErrors(errors);
      // When over maxDisplay (4 > 3), it shows count
      expect(result).toContain('4 items');
    });

    it('handles multiple error types', () => {
      const errors = [
        { path: '/a/file1.txt', error: 'Permission denied' },
        { path: '/b/file2.txt', error: 'File not found' },
      ];
      const result = formatBatchErrors(errors);
      expect(result).toContain('1 item');
    });
  });
});
