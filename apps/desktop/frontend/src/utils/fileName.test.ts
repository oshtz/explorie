import { afterEach, describe, expect, it } from 'vitest';
import { isWindowsPlatform, validateFileName } from './fileName';

const originalNavigator = globalThis.navigator;

function setNavigatorUserAgent(userAgent: string | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: userAgent === undefined ? undefined : { userAgent },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator,
  });
});

describe('isWindowsPlatform', () => {
  it('detects Windows from the navigator user agent', () => {
    setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(isWindowsPlatform()).toBe(true);

    setNavigatorUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)');
    expect(isWindowsPlatform()).toBe(false);
  });

  it('returns false when navigator is unavailable', () => {
    setNavigatorUserAgent(undefined);
    expect(isWindowsPlatform()).toBe(false);
  });
});

describe('validateFileName', () => {
  it('rejects empty names, dot segments, null characters, and path separators', () => {
    expect(validateFileName('   ')).toEqual({ valid: false, reason: 'Name cannot be empty' });
    expect(validateFileName('.')).toEqual({ valid: false, reason: 'Name cannot be . or ..' });
    expect(validateFileName('..')).toEqual({ valid: false, reason: 'Name cannot be . or ..' });
    expect(validateFileName('bad\0name')).toEqual({
      valid: false,
      reason: 'Name cannot contain null characters',
    });
    expect(validateFileName('folder/file')).toEqual({
      valid: false,
      reason: 'Name cannot contain path separators',
    });
    expect(validateFileName('folder\\file')).toEqual({
      valid: false,
      reason: 'Name cannot contain path separators',
    });
  });

  it('accepts regular names on non-Windows platforms', () => {
    setNavigatorUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    expect(validateFileName('report.final.txt')).toEqual({ valid: true });
    expect(validateFileName('name with spaces')).toEqual({ valid: true });
  });

  it('applies Windows-only invalid character, trailing character, and reserved-name rules', () => {
    setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(validateFileName('bad:name')).toEqual({
      valid: false,
      reason: 'Name contains invalid characters',
    });
    expect(validateFileName('trailing.')).toEqual({
      valid: false,
      reason: 'Name cannot end with a period or space',
    });
    expect(validateFileName('CON.txt')).toEqual({
      valid: false,
      reason: 'Name is reserved on Windows',
    });
    expect(validateFileName('regular-name.txt')).toEqual({ valid: true });
  });
});
