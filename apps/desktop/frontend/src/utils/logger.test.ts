import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debug, error, Logger, logger, LogLevel } from './logger';

describe('Logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'group').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);
    logger.clearBuffer();
    logger.setLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    logger.clearBuffer();
    vi.restoreAllMocks();
  });

  it('filters by minimum level and keeps a bounded buffer', () => {
    const log = new Logger({ minLevel: LogLevel.INFO, bufferSize: 2, showTimestamp: false });

    log.debug('hidden');
    log.info('one', { path: '/tmp' });
    log.warn('two');
    log.error('three');

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(log.getBuffer().map((entry) => entry.message)).toEqual(['two', 'three']);
  });

  it('emits structured JSON output when configured', () => {
    const log = new Logger({ minLevel: LogLevel.DEBUG, jsonOutput: true });

    log.error('failed', { code: 'E_TEST' });

    const [payload] = vi.mocked(console.error).mock.calls[0];
    expect(JSON.parse(String(payload))).toMatchObject({
      level: LogLevel.ERROR,
      levelName: 'ERROR',
      message: 'failed',
      context: { code: 'E_TEST' },
    });
  });

  it('shares the parent buffer with scoped loggers', () => {
    const log = new Logger({ minLevel: LogLevel.DEBUG, showTimestamp: false });
    const scoped = log.scope('Files');

    scoped.info('opened');

    expect(log.getBuffer()).toMatchObject([{ scope: 'Files', message: 'opened' }]);
    expect(String(vi.mocked(console.info).mock.calls[0][0])).toContain('[Files]');
  });

  it('exports, clears, and changes log level at runtime', () => {
    const log = new Logger({ minLevel: LogLevel.NONE });
    log.setLevel(LogLevel.WARN);

    log.logAt(LogLevel.WARN, 'visible');

    expect(log.getLevel()).toBe(LogLevel.WARN);
    expect(JSON.parse(log.exportBuffer())).toMatchObject([
      { levelName: 'WARN', message: 'visible' },
    ]);

    log.clearBuffer();
    expect(log.getBuffer()).toEqual([]);
  });

  it('records elapsed time with the debug logger', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(12.34);
    const log = new Logger({ minLevel: LogLevel.DEBUG });

    const stop = log.time('load');
    stop();

    expect(log.getBuffer()).toMatchObject([
      { levelName: 'DEBUG', message: 'load completed', context: { durationMs: 2.34 } },
    ]);
  });

  it('closes sync and async console groups when callbacks throw', async () => {
    const log = new Logger();

    expect(() =>
      log.group('sync group', () => {
        throw new Error('sync failed');
      })
    ).toThrow('sync failed');

    await expect(
      log.groupAsync('async group', async () => {
        throw new Error('async failed');
      })
    ).rejects.toThrow('async failed');

    expect(console.group).toHaveBeenCalledWith('sync group');
    expect(console.group).toHaveBeenCalledWith('async group');
    expect(console.groupEnd).toHaveBeenCalledTimes(2);
  });

  it('exposes singleton convenience functions', () => {
    debug('singleton debug');
    error('singleton error', { fatal: true });

    expect(logger.getBuffer()).toMatchObject([
      { levelName: 'DEBUG', message: 'singleton debug' },
      { levelName: 'ERROR', message: 'singleton error', context: { fatal: true } },
    ]);
  });
});
