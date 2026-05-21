/**
 * Structured logging surface.
 *
 * `Logger` is a thin abstraction over pino so:
 *   - the runtime / driver / server layers stay loosely coupled
 *     (they import this module's `Logger` interface, not pino
 *     directly),
 *   - tests can substitute a buffered collector,
 *   - the rest of the codebase has one place to add common fields
 *     (`requestId`, `actorId`, `class@version`, `principal.sub`,
 *     `tenant`, `manifestSha`).
 *
 * Pino is loaded lazily — Node-only deployments pay nothing for the
 * import until a logger is built; browser bundles never reach it.
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LogFields {
  /** Per-request id (Fastify generates one). */
  readonly requestId?: string;
  readonly actorId?: string;
  /** `<class>@<version>` shorthand. */
  readonly classAtVersion?: string;
  readonly principalSub?: string;
  readonly tenant?: string;
  readonly manifestSha?: string;
  readonly [extra: string]: unknown;
}

/**
 * Minimal logger contract used by every actjs subsystem.
 *
 * Implementations:
 *   - {@link makeLogger} → pino-backed, suitable for production
 *   - {@link makeNoopLogger} → drops everything (default in tests)
 *   - {@link makeCollectingLogger} → buffer events into an array
 *     (used by the logging unit tests).
 */
export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** Build a sub-logger with extra fields merged on every event. */
  child(fields: LogFields): Logger;
  /** Current level (post-resolution). Useful for guards on hot paths. */
  level: LogLevel;
}

/* --------------------------------------------------------- pino impl */

/** Subsystems that get an independent level (env-driven). */
export const SUBSYSTEMS = ['server', 'runtime', 'driver', 'handler', 'audit'] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export interface MakeLoggerOptions {
  /** Default level when no env override is present. Default `'info'`. */
  readonly level?: LogLevel;
  /** Per-subsystem level overrides (raw map, env-resolved). */
  readonly levels?: Partial<Record<Subsystem, LogLevel>>;
  /** Pretty-print stdout in dev (default off). */
  readonly pretty?: boolean;
  /** Test seam: replace the underlying pino instance. */
  readonly pino?: PinoLogger;
}

/**
 * Headers + body fields that must never appear in logged objects.
 *
 * Pino's `redact` accepts deep wildcards; we install both lowercase
 * and PascalCase variants because Fastify request headers come in
 * lowercased but route bodies often preserve the casing the client
 * sent.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-actjs-admin"]',
  'req.headers["idempotency-key"]',
  'req.headers["x-actjs-capability"]',
  '*.authorization',
  '*.Authorization',
  '*.Idempotency-Key',
  '*.idempotencyKey',
  '*.capability',
];

export function makeLogger(options: MakeLoggerOptions = {}): Logger {
  const level = resolveLevel(options.level ?? 'info', undefined);
  const subsystemLevels = resolveSubsystemLevels(options.levels);
  const pinoOpts: LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: undefined,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };
  if (options.pretty) {
    pinoOpts.transport = { target: 'pino-pretty' };
  }
  const instance = options.pino ?? pino(pinoOpts);
  return new PinoBackedLogger(instance, level, subsystemLevels);
}

function resolveLevel(fallback: LogLevel, envKey: string | undefined): LogLevel {
  if (envKey) {
    const v = process.env[envKey];
    if (v && isLogLevel(v)) return v;
  }
  const v = process.env['ACTJS_LOG_LEVEL'];
  if (v && isLogLevel(v)) return v;
  return fallback;
}

function resolveSubsystemLevels(overrides: MakeLoggerOptions['levels']): Map<Subsystem, LogLevel> {
  const map = new Map<Subsystem, LogLevel>();
  for (const sub of SUBSYSTEMS) {
    const envKey = `ACTJS_LOG_LEVEL_${sub.toUpperCase()}`;
    const override = overrides?.[sub];
    const fallback = subsystemDefault(sub);
    const resolved = resolveLevel(override ?? fallback, envKey);
    if (resolved !== fallback) map.set(sub, resolved);
    else if (override) map.set(sub, override);
  }
  return map;
}

function subsystemDefault(sub: Subsystem): LogLevel {
  // Driver logs at warn by default — chatty hot path otherwise.
  if (sub === 'driver') return 'warn';
  return 'info';
}

function isLogLevel(v: string): v is LogLevel {
  return ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(v);
}

class PinoBackedLogger implements Logger {
  readonly level: LogLevel;
  private readonly p: PinoLogger;
  private readonly subsystemLevels: Map<Subsystem, LogLevel>;

  constructor(p: PinoLogger, level: LogLevel, subsystemLevels: Map<Subsystem, LogLevel>) {
    this.p = p;
    this.level = level;
    this.subsystemLevels = subsystemLevels;
  }

  trace(msg: string, fields?: LogFields): void {
    this.p.trace(fields ?? {}, msg);
  }
  debug(msg: string, fields?: LogFields): void {
    this.p.debug(fields ?? {}, msg);
  }
  info(msg: string, fields?: LogFields): void {
    this.p.info(fields ?? {}, msg);
  }
  warn(msg: string, fields?: LogFields): void {
    this.p.warn(fields ?? {}, msg);
  }
  error(msg: string, fields?: LogFields): void {
    this.p.error(fields ?? {}, msg);
  }
  fatal(msg: string, fields?: LogFields): void {
    this.p.fatal(fields ?? {}, msg);
  }
  child(fields: LogFields): Logger {
    let childLevel: LogLevel = this.level;
    if (typeof fields['subsystem'] === 'string') {
      const sub = fields['subsystem'] as Subsystem;
      const override = this.subsystemLevels.get(sub);
      if (override) childLevel = override;
    }
    const child = this.p.child(fields, { level: childLevel });
    return new PinoBackedLogger(child, childLevel, this.subsystemLevels);
  }
}

/* --------------------------------------------------------- Noop impl */

export function makeNoopLogger(): Logger {
  return NOOP_LOGGER;
}

const NOOP_LOGGER: Logger = {
  level: 'silent',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => NOOP_LOGGER,
};

/* --------------------------------------------------------- Collector */

export interface CollectedEvent {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: LogFields;
}

/**
 * Test-only logger that records every event into the provided array.
 *
 * Child loggers merge fields onto the recorded event so assertions
 * can target the structured context as well as the message.
 */
export function makeCollectingLogger(events: CollectedEvent[], baseFields: LogFields = {}): Logger {
  const make = (fields: LogFields): Logger => {
    const merged = { ...fields };
    const record =
      (level: LogLevel) =>
      (msg: string, extra?: LogFields): void => {
        events.push({ level, msg, fields: { ...merged, ...(extra ?? {}) } });
      };
    return {
      level: 'trace',
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      child: (more: LogFields) => make({ ...merged, ...more }),
    };
  };
  return make(baseFields);
}
