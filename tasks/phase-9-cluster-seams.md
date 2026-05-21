# Phase 9 — Cluster seams (deferred)

> Source: [PLAN.md § Phase 9](../PLAN.md#phase-9--cluster-sketch-only-deferred)
> Decisions: [phase-9-cluster-seams.adr.md](./phase-9-cluster-seams.adr.md)

## Goal

We do not build clustering for v1. This task exists as a **review
checklist used during earlier phases** so the seams stay clean and
a future v2 can land placement + fencing + hot migration without
rewriting the foundations. Once enough demand exists, this task is
the starting point for the actual cluster work.

## Done when

For v1: every checkbox below is verified and any gap surfaced by the
audit is closed with the minimum change that honors the seam (no
v2 clustering code lands here). The 2026-05-20 audit closed the
three real gaps (fence token plumbing, WS pin capture per-connection,
reminders dispatcher key parameterization).

For v2 (later): the implementation tasks listed at the bottom are
broken out into their own session-sized tasks following the same
pattern as Phases 0–8.

---

## Review checklist (applied to earlier phases)

### Placement boundary

- [x] `Phase 3.1`: actor lookup is one function
      (`directory.resolve(id) → ActorHost`). Verified by audit:
      every caller of `Directory` lives in `runtime/runtime.ts`;
      no external code touches the in-process host `Map`.
- [x] `Phase 5.x`: HTTP/WS handlers don't bypass the directory.
      Routes go through `runtime.call` / `runtime.tombstone` /
      `runtime.getHost`. The GET-snapshot route reads
      `driver.loadSnapshot` directly because the snapshot is
      durable state, not directory state.
- [x] `Phase 9 ready`: swapping the directory implementation from
      "single node" to "consistent-hash + RPC" requires no changes
      outside `runtime/directory.ts`.

### Fencing token

- [x] `Phase 2`: `actor:<id>:fence` key reserved in `storage/keys.ts`;
      `actor_snapshot.seq` is monotonic per actor (PG `PRIMARY KEY (actor_id, seq)`).
- [x] `Phase 3.1`: `ActorHost.activate` reads the fence via
      `driver.loadActorFence(id)` and stashes it on
      `this.fenceToken`. v1 single-owner never bumps; v2 placement
      will. _(Audit gap closed 2026-05-20 — see ADR.)_
- [x] `Phase 9 ready`: writes with stale tokens are refused at the
      driver boundary. `saveSnapshot` and `appendEvents` accept an
      optional `expectedFence`; the driver throws
      `StaleFenceTokenError` on mismatch. `ActorHost` always passes
      the stashed token in v1 so the check is a noop today; v2
      starts incrementing the fence on each placement claim and
      stale-owner writes start failing without further runtime
      changes. _(Audit gap closed 2026-05-20.)_

### Idempotency keyed for retry

- [x] `Phase 5.1`: every mutating route accepts `Idempotency-Key`
      and the driver dedupes via `driver.loadIdempotency` /
      `driver.saveIdempotency`. v2 reuses this for caller retries
      across redirects.

### Mailbox is process-local but the inbox is shared

- [x] `Phase 3.1`: `ActorHost.tell` writes to `driver.appendInbox`
      before the in-memory mailbox enqueue (`runtime/host.ts:524`).
      `ActorHost.activate` replays
      `driver.readPendingInbox(...)` (`runtime/host.ts:334`) so a
      v2 hand-off on the new owner picks up exactly where the old
      one left off.

### Manifest pinning is request-scoped

- [x] `Phase 4`: `Manifest` lives in `src/types/envelope.ts` as a
      mandatory `manifestSha` field. The wire transports (REST,
      WS) carry the pin via `X-Actjs-Manifest` and land it in
      `req.manifestPin`.
- [x] `Phase 5.2`: WS manifest pin is per-connection — the WS
      route captures `req.manifestPin` at upgrade time alongside
      `req.principal`. _(Audit gap closed 2026-05-20.)_
- [ ] **Documented v2 gap:** in-process cross-actor calls
      (`actjs.call(ref, ...)` inside a handler) do **not**
      propagate the request's manifest pin. The bridge doesn't
      have access to the originating request context. v2
      cross-node propagation will need a per-call context
      mechanism (AsyncLocalStorage or threaded `ctx`). v1
      single-node deployments don't observe the gap because every
      handler runs in the same process under the same registered
      class version.

### Reminders durability

- [x] `Phase 3.3`: dispatcher key is configurable. `ValkeyPgOptions`
      accepts `remindersKey?: string` so v2 cluster can substitute
      a sharded scheme; v1 defaults to `k.reminders` (= `'reminders'`).
      _(Audit gap closed 2026-05-20.)_
- [x] PG mirror of reminders exists — `migrations/0002_reminders.up.sql`.

### Storage driver is the boundary

- [x] `Phase 2`: no code outside `storage/` imports `pg` or `redis`
      directly. Verified by audit: only `storage/valkey-pg.ts` and
      the legacy GAct shim (`src/gact.ts` / `routes/legacy.ts`)
      touch `redis`; the GAct shim is the pre-actjs API that
      `legacy.ts` exposes for the demo and is sunset in PLAN.md.

---

## Implementation tasks (broken out when v2 starts)

The following are _not_ sized in this task. Each becomes its own
task with checklist + ADR when the cluster work is greenlit:

- **9.1 — Membership.** Valkey-backed leader election or external
  etcd/Raft. Cluster identity, node liveness, gossiped placement
  table.
- **9.2 — Placement.** Consistent hashing on `actorId`; per-node
  ownership claim with `driver.bumpActorFence(id, expected)` on
  activate. The fence-token plumbing landed in v1; 9.2 wires up
  the caller.
- **9.3 — Cross-node RPC.** Internal protocol between nodes for
  `dispatch(envelope)`. Reuse the wire types from Phase 5.
- **9.4 — Hot migration.** Drain mailbox, snapshot, hand-off,
  resume. Coordination with subscribers (5.2) so they reconnect to
  the new owner.
- **9.5 — Client routing.** Nodes redirect (`307`) or proxy on miss.
  SDK caches resolved-node per actor with TTL.
- **9.6 — Operational story.** Rolling upgrades, partial-partition
  detection, fencing-token reset procedure.
- **9.7 — Cross-actor manifest propagation.** Threaded request
  context (AsyncLocalStorage candidate) so a handler's
  `actjs.call(ref, ...)` carries the pin through to the next
  actor's mailbox turn even across nodes.

---

## Risks & watch-outs (kept for the future)

- [ ] Optimistic placement (any node can own any actor on first
      touch) races on first-touch storms. Use a Valkey `SET NX` to
      claim ownership before activate.
- [ ] Fencing tokens that wrap (very unlikely with bigint, still
      worth a guard).
- [ ] Subscription fanout becomes node-local in v1; v2 needs a
      pub/sub plane (Valkey pub/sub or a dedicated bus) to deliver
      patches/events to subscribers on other nodes.
- [ ] Reminders dispatcher must coordinate across nodes (leader
      election or sharded ZSET keys).
- [ ] Don't try to make cross-actor transactions atomic across
      nodes — sagas are still the answer.
