/**
 * Per-instance runtime bridge.
 *
 * Each `ActorHost` constructs one of these on activate and assigns
 * it to `instance.actjs`. Handlers reach the framework's runtime
 * methods via `this.actjs.{call,tell,scheduleAt,now,log,abort}`.
 *
 * This is the run-time `actjs` — distinct from the compile-time
 * `actjs` parameter in the class-source wrapper (see
 * `class-kit.ts`). The two intentionally share a name; their
 * methods don't overlap so there's no ambiguity at the call site.
 */
import { AUDIT_ACTIONS, type Auditor } from '../audit/index.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { CapabilityIssuer, CapabilityMintInput } from '../policy/capability.js';
import type { ActorRef } from '../types/envelope.js';
import type { ActorId, ClassName } from '../types/ids.js';

/* ---------------------------------------------------- Outbound API */

/**
 * The subset of runtime methods the bridge needs. The host receives
 * these as callbacks at construction time, so a unit-test ActorHost
 * can run with no Runtime attached.
 */
export interface BridgeOutbound {
  call<R = unknown>(ref: ActorRef, method: string, args: unknown): Promise<R>;
  tell(ref: ActorRef, type: string, payload: unknown): Promise<void>;
  scheduleAt(
    when: number,
    actorId: ActorId,
    className: ClassName,
    type: string,
    payload: unknown,
  ): Promise<void>;
}

/* ---------------------------------------------------------- Logger */

/**
 * Minimal logger shape. Phase 8.1 swaps in pino; tests use console
 * or noop.
 */
export interface BridgeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: BridgeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/* --------------------------------------------------------- Errors */

export class ActorAbort extends Error {
  constructor(reason: string) {
    super(`actor aborted: ${reason}`);
    this.name = 'ActorAbort';
  }
}

/* --------------------------------------------------- Public surface */

export interface MintCapabilityArgs {
  /** Methods the capability grants on the minting actor. */
  readonly methods: readonly string[];
  /** Lifetime in milliseconds. */
  readonly ttlMs: number;
  /** Optional audience scope. */
  readonly audience?: string;
}

export interface ActjsHost {
  readonly self: ActorRef;
  call<R = unknown>(ref: ActorRef, method: string, args: unknown): Promise<R>;
  tell(ref: ActorRef, type: string, payload: unknown): Promise<void>;
  scheduleAt(when: number | Date, type: string, payload: unknown): Promise<void>;
  now(): number;
  readonly log: BridgeLogger;
  abort(reason: string): never;
  /**
   * Mint a capability token bound to *this* actor. Returns the
   * encoded JWT (or throws `Error` if no issuer is wired into the
   * runtime).
   */
  mintCapability(args: MintCapabilityArgs): string;
}

export interface BridgeOptions {
  readonly self: ActorRef;
  readonly outbound?: BridgeOutbound;
  readonly log?: BridgeLogger;
  readonly now?: () => number;
  /** Issuer used by `actjs.mintCapability`. Omit to disable. */
  readonly capabilityIssuer?: CapabilityIssuer;
  /** Auditor used to record `capability.minted`. Omit to disable audit. */
  readonly auditor?: Auditor;
  /** Metrics registry; the bridge bumps `capability_minted_total`. */
  readonly metrics?: MetricsRegistry;
}

/* ---------------------------------------------------------- Impl */

export function makeBridge(options: BridgeOptions): ActjsHost {
  const log = options.log ?? SILENT_LOGGER;
  const now = options.now ?? (() => Date.now());
  const outbound = options.outbound ?? noOutbound();
  const issuer = options.capabilityIssuer;
  const auditor = options.auditor;
  const metrics = options.metrics;
  return {
    self: options.self,
    async call<R = unknown>(ref: ActorRef, method: string, args: unknown): Promise<R> {
      return outbound.call<R>(ref, method, args);
    },
    async tell(ref: ActorRef, type: string, payload: unknown): Promise<void> {
      return outbound.tell(ref, type, payload);
    },
    async scheduleAt(when: number | Date, type: string, payload: unknown): Promise<void> {
      const ms = typeof when === 'number' ? when : when.getTime();
      return outbound.scheduleAt(ms, options.self.id, options.self.class, type, payload);
    },
    now,
    log,
    abort(reason: string): never {
      throw new ActorAbort(reason);
    },
    mintCapability(args: MintCapabilityArgs): string {
      if (!issuer) {
        throw new Error(
          'actjs.mintCapability: no CapabilityIssuer is wired into this Runtime. ' +
            'Pass `capabilityIssuer` to `new Runtime(...)`.',
        );
      }
      const input: CapabilityMintInput = {
        actor: { class: options.self.class as string, id: options.self.id as string },
        methods: args.methods,
        ttlMs: args.ttlMs,
        ...(args.audience ? { audience: args.audience } : {}),
      };
      const token = issuer.mint(input);
      metrics?.recordCapabilityMint(options.self.class as string);
      if (auditor) {
        void auditor
          .record({
            action: AUDIT_ACTIONS.CAPABILITY_MINTED,
            target: `${options.self.class as string}:${options.self.id as string}`,
            principal: 'system',
            meta: {
              methods: [...args.methods],
              ttlMs: args.ttlMs,
              ...(args.audience ? { audience: args.audience } : {}),
            },
          })
          .catch((err: unknown) => {
            log.warn?.('capability mint audit failed', {
              err: err instanceof Error ? err.message : String(err),
            });
          });
      }
      return token;
    },
  };
}

function noOutbound(): BridgeOutbound {
  const thrower = (): never => {
    throw new Error('actjs host bridge: no runtime is attached to this ActorHost');
  };
  return {
    call: thrower,
    tell: thrower,
    scheduleAt: thrower,
  };
}
