/**
 * `TestActor` — convenience handle returned from `TestRuntime.actor(...)`.
 *
 * Exposes:
 *   - `.call.<method>(args)` — request/response via the runtime.
 *   - `.tell.<method>(payload)` — fire-and-forget via the runtime.
 *   - `.id`, `.class` — the actor's identity.
 *
 * Method dispatch uses a Proxy so handlers added later in the actor's
 * source still work without touching the harness.
 */
import type { Runtime } from '../runtime/index.js';
import type { MemoryStorageDriver } from '../storage/memory.js';
import { asActorId, asClassName, type ActorId, type ClassName } from '../types/ids.js';
import type { Principal } from '../types/principal.js';

export interface TestActorOptions {
  readonly runtime: Runtime;
  readonly driver: MemoryStorageDriver;
  readonly className: string;
  readonly actorId: string;
  /** Default principal for `.call.foo(...)`. Override per-call via `.callAs`. */
  readonly principal?: Principal;
}

export interface TestActor {
  readonly id: ActorId;
  readonly class: ClassName;
  /** Backreference to the in-memory driver — used by assertion helpers. */
  readonly driver: MemoryStorageDriver;
  /** Runtime owning this actor; assertion helpers read live state through it. */
  readonly runtime: Runtime;
  /** Dispatch a request/response handler. */
  readonly call: Record<string, (args?: unknown) => Promise<unknown>>;
  /** Dispatch a fire-and-forget handler. */
  readonly tell: Record<string, (payload?: unknown) => Promise<void>>;
  /** One-off principal override. */
  callAs<R = unknown>(principal: Principal, method: string, args?: unknown): Promise<R>;
  tellAs(principal: Principal, type: string, payload?: unknown): Promise<void>;
}

export function makeTestActor(options: TestActorOptions): TestActor {
  const { runtime, principal } = options;
  const className = asClassName(options.className);
  const actorId = asActorId(options.actorId);
  const call = new Proxy(
    Object.create(null) as Record<string, (args?: unknown) => Promise<unknown>>,
    {
      get(_target, method: string) {
        return (args: unknown = {}) => runtime.call(className, actorId, method, args, principal);
      },
    },
  );
  const tell = new Proxy(
    Object.create(null) as Record<string, (payload?: unknown) => Promise<void>>,
    {
      get(_target, type: string) {
        return (payload: unknown = {}) =>
          runtime.tell(className, actorId, type, payload, principal);
      },
    },
  );
  return {
    id: actorId,
    class: className,
    driver: options.driver,
    runtime,
    call,
    tell,
    callAs<R = unknown>(asPrincipal: Principal, method: string, args: unknown = {}): Promise<R> {
      return runtime.call<R>(className, actorId, method, args, asPrincipal);
    },
    tellAs(asPrincipal: Principal, type: string, payload: unknown = {}): Promise<void> {
      return runtime.tell(className, actorId, type, payload, asPrincipal);
    },
  };
}
