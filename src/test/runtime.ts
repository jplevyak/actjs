/**
 * `TestRuntime` — the in-process harness behind `@actjs/test`.
 *
 * Wraps `MemoryStorageDriver` + `Runtime` with developer-friendly
 * affordances:
 *
 *   - register classes by ctor (versioned `1.0.0` by default).
 *   - `t.actor(Ctor)` mints a fresh actor and returns a {@link TestActor}.
 *   - `t.advanceTime(ms)` bumps the test clock and fires any due
 *     reminders deterministically (no setTimeout race).
 *   - `t.now` is the canonical clock — driver, runtime, and host all
 *     read from it, so `actjs.now()` inside a handler matches the
 *     value the test sees.
 *
 * The harness deliberately *does not* start the production reminder-
 * dispatcher loop. `advanceTime` drains reminders synchronously so
 * tests stay deterministic; concurrent ticks would race against
 * test assertions.
 */
import type { Actor } from '../actor.js';
import { Runtime, type RegisterClassOptions, type RuntimeOptions } from '../runtime/index.js';
import { MemoryStorageDriver } from '../storage/memory.js';
import { asClassName, asVersion, mkActorId, type ActorId, type ClassName } from '../types/ids.js';
import { systemPrincipal, type Principal } from '../types/principal.js';

import { makeTestActor, type TestActor } from './actor-ref.js';

export interface ClassRegistration {
  readonly name?: string;
  readonly version?: string;
  readonly ctor: new () => Actor;
  /** Optional overrides forwarded to `runtime.register`. */
  readonly options?: Omit<RegisterClassOptions, 'name' | 'version' | 'ctor'>;
}

export type ClassMap = Readonly<Record<string, ClassRegistration | (new () => Actor)>>;

export interface CreateOptions {
  readonly classes: ClassMap;
  /** Initial wall-clock value. Default `1700000000000`. */
  readonly now?: number;
  /**
   * Default principal applied when `t.actor(...)` doesn't override
   * it. Defaults to a friendly `{sub: 'test-user', roles: []}`.
   */
  readonly principal?: Principal;
  /** Extra runtime options (capability issuer, audit, metrics). */
  readonly runtime?: Omit<RuntimeOptions, 'reminders'>;
}

const DEFAULT_NOW = 1_700_000_000_000;
const DEFAULT_PRINCIPAL: Principal = { sub: 'test-user', roles: [] };

export class TestRuntime {
  /** Settable clock used by the driver, dispatcher, and host. */
  now: number;
  readonly driver: MemoryStorageDriver;
  readonly runtime: Runtime;
  private readonly defaultPrincipal: Principal;

  private constructor(options: CreateOptions) {
    this.now = options.now ?? DEFAULT_NOW;
    this.defaultPrincipal = options.principal ?? DEFAULT_PRINCIPAL;
    this.driver = new MemoryStorageDriver();
    this.driver.now = () => this.now;
    this.runtime = new Runtime(this.driver, {
      ...(options.runtime ?? {}),
      nowMs: () => this.now,
      reminders: { nowMs: () => this.now, tickMs: 60_000_000 },
    });
    // Register the supplied classes immediately so `t.actor(Ctor)` works
    // without an extra step.
    for (const [name, entry] of Object.entries(options.classes)) {
      const reg = isCtor(entry) ? { ctor: entry } : entry;
      const className = (reg.name ?? name) as ClassName & string;
      this.runtime.register({
        name: asClassName(className),
        version: asVersion(reg.version ?? '1.0.0'),
        ctor: reg.ctor,
        ...(reg.options ?? {}),
      });
    }
  }

  static async create(options: CreateOptions): Promise<TestRuntime> {
    const t = new TestRuntime(options);
    await t.driver.init();
    return t;
  }

  /**
   * Mint a fresh actor of the registered class. The class can be
   * passed either as the ctor (looked up by `name`) or as the
   * registered name string.
   */
  actor(ctorOrName: (new () => Actor) | string, init: unknown = {}): TestActor {
    const className = typeof ctorOrName === 'string' ? ctorOrName : ctorOrName.name;
    const id = mkActorId();
    const actor = makeTestActor({
      runtime: this.runtime,
      driver: this.driver,
      className,
      actorId: id as string,
      principal: this.defaultPrincipal,
    });
    // Materialize lazily on first call; init is currently ignored
    // here (the Runtime doesn't yet accept onInit args) but the
    // shape stays compatible with the Phase 6.x roadmap.
    void init;
    return actor;
  }

  /**
   * Materialize an existing actor by id. Useful for fetching the
   * same actor twice in a multi-actor test.
   */
  actorRef(className: string, id: ActorId): TestActor {
    return makeTestActor({
      runtime: this.runtime,
      driver: this.driver,
      className,
      actorId: id as string,
      principal: this.defaultPrincipal,
    });
  }

  /**
   * Bump the clock by `ms`. Reminders whose scheduled time has
   * arrived fire as system-principal `tell` calls, in scheduled
   * order. Returns the number of reminders delivered.
   *
   * Reminders that themselves schedule further reminders are
   * surfaced naturally — `advanceTime(60_000)` may deliver more
   * than one "wave" if a fired reminder enqueued another before
   * the clock moved past its `when`.
   */
  async advanceTime(ms: number): Promise<number> {
    if (ms < 0) throw new Error('advanceTime cannot rewind the clock');
    this.now += ms;
    return this.drainReminders();
  }

  /**
   * Fire every due reminder at the *current* clock. Safe to call
   * after manual `t.now` adjustments.
   */
  async drainReminders(): Promise<number> {
    let delivered = 0;
    // Cap the loop in case a runaway reminder keeps scheduling more
    // reminders due at the same time. 10k is generous for unit tests.
    for (let iter = 0; iter < 10_000; iter++) {
      const due: { className: string; actorId: string; type: string; payload: unknown }[] = [];
      for await (const msg of this.driver.popDueReminders(this.now, 1024)) {
        due.push({
          className: msg.className as string,
          actorId: msg.actorId as string,
          type: msg.type,
          payload: msg.payload,
        });
      }
      if (due.length === 0) break;
      for (const m of due) {
        await this.runtime.tell(
          asClassName(m.className),
          m.actorId as ActorId,
          m.type,
          m.payload,
          systemPrincipal(),
        );
        delivered++;
      }
    }
    return delivered;
  }

  /** Drain every active actor's mailbox. */
  async drain(): Promise<void> {
    await this.runtime.drain();
  }

  /** Release resources. Idempotent. */
  async close(): Promise<void> {
    await this.runtime.shutdown();
    await this.driver.close();
  }
}

function isCtor(value: ClassRegistration | (new () => Actor)): value is new () => Actor {
  return typeof value === 'function';
}
