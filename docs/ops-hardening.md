# Operations: audit, signing, limits

Phase 7.2 ships the three production-hardening features that an
operator needs before turning an actjs server loose on real traffic:

1. An **append-only audit log** that records every privileged action.
2. Optional **code signing** for class publishes — Ed25519 over the
   source sha256.
3. Per-principal **rate limiting** and per-class **active-actor
   caps** that surface as well-known HTTP 4xx/5xx codes so clients
   can back off cleanly.

Each subsystem is independent; you can pick them up one at a time.

---

## Audit log

Every privileged action funnels through an `Auditor` which appends
an immutable row to the `audit` table (Postgres) or to the in-memory
log (test driver). The `Runtime` builds a strict-mode auditor by
default; pass `{ auditOptions: { mode: 'best-effort' } }` to opt out
of strict propagation.

### Actions

| Action                | Source                                         |
| --------------------- | ---------------------------------------------- |
| `class.published`     | `POST /v1/classes/:name/versions`              |
| `class.deprecated`    | `PATCH /v1/classes/:name/versions/:version`    |
| `class.signed`        | Same publish call when a signature is verified |
| `actor.tombstoned`    | `DELETE /v1/actors/:class/:id`                 |
| `actor.migrated`      | `ActorHost` snapshot migration                 |
| `capability.minted`   | `actjs.mintCapability(...)` inside a handler   |
| `signing-key.added`   | `POST /v1/admin/signing-keys/:kid`             |
| `signing-key.revoked` | `DELETE /v1/admin/signing-keys/:kid`           |
| `admin.rpc`           | Legacy `POST /run`                             |

Each entry has the shape:

```ts
{
  id: string; // uuid
  ts: number; // epoch ms
  principal: string; // `Principal.sub` of the caller, "anonymous", or "system"
  action: string; // see table above
  target: string; // resource identifier, e.g. "Note@1.2.0", "Counter:abc"
  meta: object; // action-specific extras
}
```

### Strict vs best-effort

```ts
new Runtime(driver, { auditOptions: { mode: 'strict' } }); // default
new Runtime(driver, { auditOptions: { mode: 'best-effort' } });
```

In strict mode, a failed `driver.appendAudit` throws an
`AuditWriteError` that propagates back through the calling route.
The privileged action is therefore atomic with the audit emission.
Use best-effort only when the cost of refusing the action exceeds
the cost of a missing audit row (rare; not recommended for
compliance-driven deployments).

### S3 mirror (deferred)

The PG-backed driver writes audit entries synchronously to the
`audit` table. The optional S3 mirror — for object-lock retention —
lands in 7.2b along with the PG-backed blocklist and signing-key
registry. The current schema is forward-compatible.

---

## Code signing

Optional. When enabled, publishes must carry a verifiable Ed25519
signature over `sha256:<hex>|<name>@<version>`. The verified kid is
written to the `class_version.signed_by` column and emitted as a
separate `class.signed` audit entry.

### Wiring

```ts
import { MemorySigningKeyRegistry } from 'actjs/registry';

const signingKeys = new MemorySigningKeyRegistry({ auditor: runtime.auditor });
await signingKeys.add('release-key-2026', publicKeyPem);

const app = await buildApp({
  driver,
  runtime,
  signingKeys,
  requireSignedClasses: true, // optional; default false
});
```

With `requireSignedClasses: true`, an unsigned publish is rejected
with `400 SignatureRequired`. A bad signature (revoked key, tampered
bytes, wrong kid) returns `400 SignatureInvalid`.

### Publishing with the CLI

```bash
actctl key add --server $URL --kid release-key-2026 --pem ./release.pub.pem
actctl publish \
  --server $URL --name Note --version 1.2.0 --source ./Note.ts \
  --sign ./release.priv.pem --kid release-key-2026
```

`actctl publish --sign` reads the source, SHA-256s it, builds the
canonical signing payload, and signs with the supplied Ed25519
private key. The server verifies against the kid's stored public
key.

### Rotation

Use `actctl key add` for the new kid before flipping production
clients over; revoke the old kid only after the rollover. Each add
and revoke emits an audit entry, so an operator can prove who
introduced a key and when.

---

## Rate limits

Per-principal **token bucket**. Every `actor.call` consumes one
token; the configured capacity refills at a steady rate. A request
that finds the bucket empty returns `429 RateLimited` with a
`Retry-After` header.

### Wiring

```ts
new Runtime(driver, {
  rateLimiter: {
    default: { capacity: 1000, refillPerSec: 1000 / 60 }, // 1k calls/min
    perRole: {
      admin: { capacity: 10_000, refillPerSec: 10_000 / 60 },
    },
  },
});
```

The runtime exempts the `system` principal automatically (used by
the reminder dispatcher and reactivation tells).

### Per-class active-actor cap

The directory tracks active actors per class. When the cap is set
and reached, a fresh activation throws `CapacityExhaustedError`
which the server returns as `503 CapacityExhausted` with the
configured cap in the body.

```ts
new Runtime(driver, { activeActorCapPerClass: 100_000 });
```

A cap of `0` or unset means unlimited. Pick a generous default —
production deployments rarely need to clamp here except as a brake
against runaway code paths that mint actors without bound.

### Mailbox cap (3.1)

The per-actor mailbox cap is already enforced inside the host
(`MailboxFullError` → 429 `MailboxFull`). Phase 7.2 surfaces the
counter on `actorHost.metrics.tellsDropped` for the dashboards
landing in 8.1.

### Multi-node note

The in-process token bucket and active-actor counter are advisory
across nodes — each node enforces its share independently. A
Valkey-backed shared counter is the v2 work item; the call-site
interface stays the same so flipping the implementation is a
constructor swap.

---

## Operator runbook

- **Audit failure spike:** if `AuditWriteError` shows up in the
  logs, the underlying driver is failing. Strict-mode failures
  refuse the action; switch to best-effort only if you've already
  accepted the trade-off and have alerting on the driver health.
- **Capability blocklist lag:** the `CachedBlocklist` (10 s TTL by
  default) trades a small revocation window for hot-path latency.
  Operators who need stricter timing should drop the TTL or wire
  the underlying store directly.
- **Rate-limit alerts:** every 429 emits a structured log line with
  `subject`, `operation`, and `retryAfterSeconds`. Dashboards in
  8.1 chart these by subject.
- **Active-actor cap alerts:** every 503 logs the class and the
  configured cap. A persistent breach implies either a leak or a
  cap set too low — investigate before bumping.
