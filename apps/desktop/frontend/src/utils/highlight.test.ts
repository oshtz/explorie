import { describe, expect, it } from 'vitest';
import { highlightCode, isPlaintextLanguage, resolveHighlightLanguage } from './highlight';

describe('resolveHighlightLanguage', () => {
  it('resolves by extension', () => {
    expect(resolveHighlightLanguage({ ext: 'ts' })).toBe('typescript');
    expect(resolveHighlightLanguage({ ext: 'PY' })).toBe('python');
  });

  it('resolves by mime', () => {
    expect(resolveHighlightLanguage({ mime: 'text/plain' })).toBe('plaintext');
    expect(resolveHighlightLanguage({ mime: 'text/unknown' })).toBe('plaintext');
  });
});

describe('highlightCode', () => {
  it('highlights known languages', () => {
    const output = highlightCode('const x = 1;', 'typescript');
    expect(output).toContain('const');
  });
});

describe('isPlaintextLanguage', () => {
  it('detects plaintext', () => {
    expect(isPlaintextLanguage('plaintext')).toBe(true);
    expect(isPlaintextLanguage('typescript')).toBe(false);
  });
});
