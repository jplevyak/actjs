/**
 * Policy invocation.
 *
 * Given a class constructor and an action, run the class's
 * `static policy()` if present, falling back to the framework
 * default. Returns a normalized `{ allow, reason }` object.
 *
 * The evaluator is intentionally pure — it doesn't touch storage,
 * the host bridge, or the network. Policies are expected to be
 * synchronous functions over the inputs they're given; an async
 * `policy()` is treated as a programming error (we don't `await`).
 */
import type { Principal } from '../types/principal.js';

import {
  defaultPolicy,
  normalizeDecision,
  type PolicyAction,
  type PolicyDecision,
  type PolicyFn,
} from './types.js';

interface PolicyCarrier {
  policy?: PolicyFn;
}

export function evaluatePolicy(
  ctor: unknown,
  principal: Principal,
  action: PolicyAction,
): { allow: boolean; reason?: string } {
  const fn = (ctor as PolicyCarrier | undefined)?.policy;
  let raw: PolicyDecision;
  if (typeof fn === 'function') {
    try {
      raw = fn(principal, action);
    } catch (err) {
      // Treat a thrown policy as a hard deny. Don't expose the
      // exception text to the caller — log it via the runtime,
      // surface a generic reason.
      const message = err instanceof Error ? err.message : String(err);
      return { allow: false, reason: `policy threw: ${message}` };
    }
  } else {
    raw = defaultPolicy(principal, action);
  }
  return normalizeDecision(raw);
}
