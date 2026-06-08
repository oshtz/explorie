/* eslint-disable no-console */
/**
 * Structured logging utility for explorie.
 *
 * Provides consistent logging with:
 * - Log levels (debug, info, warn, error)
 * - Timestamps
 * - Context metadata
 * - Log buffer for debugging
 * - Environment-based control
 *
 * Usage:
 *   import { logger, LogLevel } from './logger';
 *
 *   // Simple logging
 *   logger.debug('Entering function', { fn: 'myFunction' });
 *   logger.info('Operation started', { path: '/some/path' });
 *   logger.warn('Deprecated feature used');
 *   logger.error('Operation failed', { error: err });
 *
 *   // Create scoped logger
 *   const log = logger.scope('FileOperations');
 *   log.info('Copying file', { src, dest });
 *
 *   // Get recent logs for debugging
 *   const recentLogs = logger.getBuffer();
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  levelName: string;
  scope?: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface LoggerConfig {
  /** Minimum log level to output. Default: DEBUG in dev, WARN in prod */
  minLevel?: LogLevel;
  /** Maximum entries to keep in buffer. Default: 100 */
  bufferSize?: number;
  /** Whether to include timestamps in console output. Default: true */
  showTimestamp?: boolean;
  /** Whether to output as JSON. Default: false */
  jsonOutput?: boolean;
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.NONE]: 'NONE',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '#888',
  [LogLevel.INFO]: '#4a9eff',
  [LogLevel.WARN]: '#ffb347',
  [LogLevel.ERROR]: '#ff6b6b',
  [LogLevel.NONE]: '#fff',
};

class Logger {
  private config: Required<LoggerConfig>;
  private buffer: LogEntry[] = [];
  private scopeName?: string;

  constructor(config: LoggerConfig = {}, scopeName?: string) {
    const isDev = import.meta.env.DEV;
    this.config = {
      minLevel: config.minLevel ?? (isDev ? LogLevel.DEBUG : LogLevel.WARN),
      bufferSize: config.bufferSize ?? 100,
      showTimestamp: config.showTimestamp ?? true,
      jsonOutput: config.jsonOutput ?? false,
    };
    this.scopeName = scopeName;
  }

  /**
   * Create a scoped logger that prefixes all messages with a scope name.
   */
  createScope(scopeName: string): Logger {
    const scoped = new Logger(this.config, scopeName);
    scoped.buffer = this.buffer; // Share buffer
    return scoped;
  }

  /**
   * Alias for createScope for convenience.
   */
  scope(scopeName: string): Logger {
    return this.createScope(scopeName);
  }

  /**
   * Set the minimum log level at runtime.
   */
  setLevel(level: LogLevel): void {
    this.config.minLevel = level;
  }

  /**
   * Get the current minimum log level.
   */
  getLevel(): LogLevel {
    return this.config.minLevel;
  }

  /**
   * Get the log buffer (recent log entries).
   */
  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }

  /**
   * Clear the log buffer.
   */
  clearBuffer(): void {
    this.buffer = [];
  }

  /**
   * Export buffer as JSON string (useful for error reports).
   */
  exportBuffer(): string {
    return JSON.stringify(this.buffer, null, 2);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level < this.config.minLevel) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      levelName: LEVEL_NAMES[level],
      scope: this.scopeName,
      message,
      context,
    };

    // Add to buffer
    this.buffer.push(entry);
    if (this.buffer.length > this.config.bufferSize) {
      this.buffer.shift();
    }

    // Output to console
    this.output(entry);
  }

  private output(entry: LogEntry): void {
    if (this.config.jsonOutput) {
      // JSON output for structured logging tools
      const consoleFn = this.getConsoleFn(entry.level);
      consoleFn(JSON.stringify(entry));
      return;
    }

    // Formatted console output
    const consoleFn = this.getConsoleFn(entry.level);
    const parts: string[] = [];
    const styles: string[] = [];

    // Timestamp
    if (this.config.showTimestamp) {
      const time = entry.timestamp.split('T')[1].split('.')[0]; // HH:MM:SS
      parts.push(`%c[${time}]`);
      styles.push('color: #666');
    }

    // Level
    parts.push(`%c[${entry.levelName}]`);
    styles.push(`color: ${LEVEL_COLORS[entry.level]}; font-weight: bold`);

    // Scope
    if (entry.scope) {
      parts.push(`%c[${entry.scope}]`);
      styles.push('color: #9b59b6');
    }

    // Message
    parts.push(`%c${entry.message}`);
    styles.push('color: inherit');

    // Output
    if (entry.context && Object.keys(entry.context).length > 0) {
      consoleFn(parts.join(' '), ...styles, entry.context);
    } else {
      consoleFn(parts.join(' '), ...styles);
    }
  }

  private getConsoleFn(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case LogLevel.DEBUG:
        return console.debug.bind(console);
      case LogLevel.INFO:
        return console.info.bind(console);
      case LogLevel.WARN:
        return console.warn.bind(console);
      case LogLevel.ERROR:
        return console.error.bind(console);
      default:
        return console.log.bind(console);
    }
  }

  /**
   * Log a debug message. Only shown in development by default.
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * Log an info message.
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * Log a warning message.
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  /**
   * Log an error message.
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  /**
   * Log with explicit level.
   */
  logAt(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.log(level, message, context);
  }

  /**
   * Create a timer for performance logging.
   * Returns a function that logs the elapsed time when called.
   */
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const elapsed = performance.now() - start;
      this.debug(`${label} completed`, { durationMs: Math.round(elapsed * 100) / 100 });
    };
  }

  /**
   * Group related log messages together.
   */
  group(label: string, fn: () => void): void {
    console.group(label);
    try {
      fn();
    } finally {
      console.groupEnd();
    }
  }

  /**
   * Async version of group.
   */
  async groupAsync(label: string, fn: () => Promise<void>): Promise<void> {
    console.group(label);
    try {
      await fn();
    } finally {
      console.groupEnd();
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for custom instances
export { Logger };

// Convenience exports
export const { debug, info, warn, error } = {
  debug: (msg: string, ctx?: Record<string, unknown>) => logger.debug(msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => logger.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => logger.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => logger.error(msg, ctx),
};
