import { describe, expect, it } from 'vitest';
import { formatLocalDate, formatLocalDateTime, parseToMs } from './date';

describe('parseToMs', () => {
  it('returns null for empty values', () => {
    expect(parseToMs(null)).toBeNull();
    expect(parseToMs(undefined)).toBeNull();
    expect(parseToMs('')).toBeNull();
  });

  it('parses seconds and milliseconds', () => {
    expect(parseToMs(1_710_000_000)).toBe(1_710_000_000 * 1000);
    expect(parseToMs(1_710_000_000_000)).toBe(1_710_000_000_000);
    expect(parseToMs('1710000000')).toBe(1_710_000_000 * 1000);
  });

  it('parses common date strings', () => {
    const expected = Date.parse('2024-01-01T10:30:00');
    expect(parseToMs('2024-01-01 10:30:00')).toBe(expected);
  });

  it('parses Rust-style epoch objects', () => {
    expect(parseToMs({ secs_since_epoch: 2, nanos_since_epoch: 500_000_000 })).toBe(2500);
    expect(parseToMs({ Positive: { secs_since_epoch: '3', nanos_since_epoch: '0' } })).toBe(3000);
  });
});

describe('formatters', () => {
  it('return "-" for invalid values', () => {
    expect(formatLocalDateTime('not-a-date')).toBe('-');
    expect(formatLocalDate('not-a-date')).toBe('-');
  });

  it('format valid values', () => {
    expect(formatLocalDateTime(0)).not.toBe('-');
    expect(formatLocalDate(0)).not.toBe('-');
  });
});
