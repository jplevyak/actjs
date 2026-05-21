/**
 * `Principal` — the type the auth hook produces, threaded through
 * every layer that needs to know "who is this?".
 *
 * Originally introduced in Phase 5.3 in `src/server/auth.ts`. Moved
 * here in Phase 7.1 so the runtime can import it without pulling in
 * Fastify; `server/auth.ts` re-exports for backwards compatibility.
 */

export interface Principal {
  /** Stable subject identifier (e.g. user id, service name). */
  readonly sub: string;
  /** Role names; admin routes check for `'admin'` here. */
  readonly roles?: readonly string[];
  /** Tenant / org scope, when the deployment is multi-tenant. */
  readonly tenant?: string;
  /** Capability tokens verified for this principal (Phase 7.1). */
  readonly capabilities?: readonly string[];
  /** Free-form claims forwarded from the verifier; opaque to actjs. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

export const ANONYMOUS_SUB = 'anonymous';
export const SYSTEM_SUB = 'system';

export function anonymousPrincipal(): Principal {
  return { sub: ANONYMOUS_SUB, roles: [] };
}

/**
 * "System" principal — used for runtime-internal callers (reminder
 * dispatcher, reactivation tells, future intra-cluster RPC). Policy
 * checks bypass entirely for the system principal; never expose
 * this through an external code path.
 */
export function systemPrincipal(): Principal {
  return { sub: SYSTEM_SUB, roles: ['system'] };
}

export function isAnonymous(p: Principal): boolean {
  return p.sub === ANONYMOUS_SUB;
}

export function isSystem(p: Principal): boolean {
  return p.sub === SYSTEM_SUB;
}

export function hasRole(p: Principal | undefined, role: string): boolean {
  return p?.roles?.includes(role) ?? false;
}

export function hasCapability(p: Principal | undefined, capability: string): boolean {
  return p?.capabilities?.includes(capability) ?? false;
}
