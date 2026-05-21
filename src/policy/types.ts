/**
 * Policy interface — the typed contract a class's `static policy()`
 * function implements. Lives in its own module (not `src/server/`)
 * because the policy check runs in the runtime *before* a message
 * reaches the mailbox; the server is just one of the surfaces that
 * supply a `Principal`.
 *
 * Decision shape:
 *
 *   - `'allow'` / `'deny'` — terse shorthand.
 *   - `{ allow: boolean; reason?: string }` — explicit object with
 *     an optional reason that surfaces in the problem detail (after
 *     sanitization) so the caller knows *why* they were denied.
 *
 * The default policy (when a class declares none) is
 * "principal !== Anonymous → allow." That's looser than zero-trust
 * by design — actjs is a self-hosted library that trusts its own
 * classes by default. Tighten by declaring `static policy`.
 */
import type { ActorRef } from '../types/envelope.js';
import type { Principal } from '../types/principal.js';

/* ----------------------------------------------------- Public types */

/**
 * The action a Principal is attempting to take. The runtime fills
 * `actor` with the materialized actor's current state where
 * applicable (`call`, `read`, `destroy`); `create` doesn't have an
 * actor yet so it only carries the constructor args.
 */
export type PolicyAction<S = unknown> =
  | {
      readonly kind: 'call';
      readonly method: string;
      readonly args: unknown;
      readonly actor: PolicyActor<S>;
    }
  | { readonly kind: 'read'; readonly actor: PolicyActor<S> }
  | { readonly kind: 'create'; readonly args: unknown }
  | { readonly kind: 'destroy'; readonly actor: PolicyActor<S> };

/**
 * Lightweight view of the target actor that's passed into `policy()`.
 * Deliberately read-only and free of the host bridge so policies
 * can't issue `actjs.call` / scheduling / I/O from inside the check.
 */
export interface PolicyActor<S = unknown> {
  readonly ref: ActorRef;
  readonly state: S;
}

export type PolicyDecisionLiteral = 'allow' | 'deny';
export interface PolicyDecisionObject {
  readonly allow: boolean;
  readonly reason?: string;
}
export type PolicyDecision = PolicyDecisionLiteral | PolicyDecisionObject;

/**
 * The signature a class's static `policy()` matches. Defined as a
 * type alias so consumers (codegen, tests) can write the same
 * shape without circular imports against `Actor`.
 */
export type PolicyFn<S = unknown> = (
  principal: Principal,
  action: PolicyAction<S>,
) => PolicyDecision;

/* ----------------------------------------------------- Errors */

export class PolicyDeniedError extends Error {
  readonly code = 'PolicyDenied';
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'PolicyDenied';
    this.reason = reason;
  }
}

/* ----------------------------------------------------- Defaults */

/** True iff the principal isn't the anonymous one. */
export function isAuthenticated(p: Principal): boolean {
  return p.sub !== 'anonymous';
}

/**
 * Normalize a {@link PolicyDecision} to a uniform object shape so
 * the runtime can branch on `allow` without re-typing on every
 * call site.
 */
export function normalizeDecision(d: PolicyDecision): { allow: boolean; reason?: string } {
  if (d === 'allow') return { allow: true };
  if (d === 'deny') return { allow: false };
  return d.reason !== undefined ? { allow: d.allow, reason: d.reason } : { allow: d.allow };
}

/**
 * Default policy when a class declares no `static policy()`.
 *
 * **Allow-everything** — actjs is a self-hosted, trust-your-own-
 * classes library; the absence of a policy is read as "this class
 * has no special authorization needs." Classes that want gating
 * declare `static policy()` explicitly.
 *
 * We deliberately do **not** default to authenticated-only:
 *
 * - The auth hook is BYO and may legitimately be omitted in dev /
 *   behind a reverse proxy; refusing all anonymous calls would
 *   ship a server that doesn't work out of the box.
 * - The boundary between "anonymous" and "authenticated" is
 *   meaningful only to the application, not to the framework —
 *   only the application knows whether a given anonymous request
 *   is a public read or a privilege escalation attempt.
 *
 * To opt into the stricter "require an authenticated principal"
 * stance, declare `static policy()` and use {@link isAuthenticated}.
 */
export function defaultPolicy(_principal: Principal, _action: PolicyAction): PolicyDecision {
  return 'allow';
}
