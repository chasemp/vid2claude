/**
 * Run log.
 *
 * The recordings that go wrong are the ones nobody can send you: a 61 MB file
 * on someone's phone. The log has to carry enough that the file itself is not
 * needed — what the container held, what the browser said it could decode, what
 * each stage did, and exactly where it stopped.
 *
 * Always on, bounded, and scrubbed of anything secret before it leaves.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export interface LogEntry {
  /** Milliseconds since the log was created. */
  atMs: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Oldest entries are dropped past this. */
  capacity?: number;
  /** Entries below this level are not kept. */
  minLevel?: LogLevel;
  now?: () => number;
}

/** Anything that looks like a credential never reaches the log. */
export function redact(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, "[redacted-token]")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "$1 [redacted]");
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[too deep]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactDeep(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /token|secret|password|authorization/i.test(key)
        ? "[redacted]"
        : redactDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private readonly entries: LogEntry[] = [];
  private readonly capacity: number;
  private readonly minLevel: LogLevel;
  private readonly startedAt: number;
  private readonly now: () => number;
  private dropped = 0;

  constructor(opts: LoggerOptions = {}) {
    this.capacity = opts.capacity ?? 3000;
    this.minLevel = opts.minLevel ?? "trace";
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.startedAt = this.now();
  }

  log(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      atMs: Math.round(this.now() - this.startedAt),
      level,
      scope,
      message: redact(message),
    };
    if (data !== undefined) entry.data = redactDeep(data) as Record<string, unknown>;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      // Keep the beginning: the first failure explains the rest.
      this.entries.splice(this.capacity / 2, 1);
      this.dropped += 1;
    }
  }

  trace = (scope: string, message: string, data?: Record<string, unknown>) => this.log("trace", scope, message, data);
  debug = (scope: string, message: string, data?: Record<string, unknown>) => this.log("debug", scope, message, data);
  info = (scope: string, message: string, data?: Record<string, unknown>) => this.log("info", scope, message, data);
  warn = (scope: string, message: string, data?: Record<string, unknown>) => this.log("warn", scope, message, data);
  error = (scope: string, message: string, data?: Record<string, unknown>) => this.log("error", scope, message, data);

  /** Records an error with its type, message and any media error it carries. */
  failure(scope: string, message: string, err: unknown, data?: Record<string, unknown>): void {
    const detail: Record<string, unknown> = { ...data };
    if (err instanceof Error) {
      detail.errorName = err.name;
      detail.errorMessage = err.message;
      const mediaError = (err as { mediaError?: MediaError | null }).mediaError;
      if (mediaError) detail.mediaErrorCode = mediaError.code;
      const context = (err as { context?: unknown }).context;
      if (context) detail.errorContext = context;
    } else {
      detail.error = String(err);
    }
    this.log("error", scope, message, detail);
  }

  /** A scoped view, so call sites do not repeat the scope name. */
  scoped(scope: string) {
    return {
      trace: (message: string, data?: Record<string, unknown>) => this.trace(scope, message, data),
      debug: (message: string, data?: Record<string, unknown>) => this.debug(scope, message, data),
      info: (message: string, data?: Record<string, unknown>) => this.info(scope, message, data),
      warn: (message: string, data?: Record<string, unknown>) => this.warn(scope, message, data),
      error: (message: string, data?: Record<string, unknown>) => this.error(scope, message, data),
      failure: (message: string, err: unknown, data?: Record<string, unknown>) =>
        this.failure(scope, message, err, data),
    };
  }

  get size(): number {
    return this.entries.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  toEntries(): LogEntry[] {
    return [...this.entries];
  }

  /** One line per entry: readable in a chat window, greppable in a terminal. */
  toText(): string {
    const lines = this.entries.map((entry) => {
      const seconds = (entry.atMs / 1000).toFixed(3).padStart(8, " ");
      const level = entry.level.toUpperCase().padEnd(5, " ");
      const data = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
      return `${seconds}s ${level} ${entry.scope}: ${entry.message}${data}`;
    });
    if (this.dropped > 0) {
      lines.push(`(${this.dropped} middle entries dropped to stay within ${this.capacity})`);
    }
    return lines.join("\n") + "\n";
  }
}

export type ScopedLogger = ReturnType<Logger["scoped"]>;

/** A logger that keeps nothing, for call sites that have not been given one. */
export const nullLogger: ScopedLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  failure: () => {},
};
