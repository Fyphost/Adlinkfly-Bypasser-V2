/**
 * Minimal structured (JSON lines) logger with level filtering, child bindings
 * and secret redaction. Writes to stdout so it plays well with container log
 * collectors.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_KEYS = /^(authorization|x-api-key|api[_-]?key|password|secret|token|cookie|set-cookie|proxy-authorization)$/i;

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  sink?: LogSink;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  readonly level: LogLevel;
  private readonly bindings: Record<string, unknown>;
  private readonly sink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? ((line) => process.stdout.write(line + '\n'));
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({ level: this.level, bindings: { ...this.bindings, ...bindings }, sink: this.sink });
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level] && level !== 'silent';
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const record = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(this.bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    try {
      this.sink(JSON.stringify(record));
    } catch {
      // Never let logging failures (e.g. circular structures) break request handling.
      this.sink(JSON.stringify({ time: record.time, level, msg, logError: 'unserialisable fields' }));
    }
  }
}

/** Formats a URL for logs according to the configured privacy mode. */
export function formatUrlForLog(url: string | null | undefined, mode: 'full' | 'host' | 'none'): string | undefined {
  if (!url) return undefined;
  if (mode === 'none') return '[omitted]';
  if (mode === 'full') return url;
  try {
    return new URL(url).host;
  } catch {
    return '[invalid]';
  }
}

export const silentLogger = new Logger({ level: 'silent' });
