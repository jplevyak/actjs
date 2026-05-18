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

For v1: every checkbox below is verified during the relevant
earlier phase's PR (the PR description should reference this
checklist).

For v2 (later): the implementation tasks listed at the bottom are
broken out into their own session-sized tasks following the same
pattern as Phases 0–8.

---

## Review checklist (applied to earlier phases)

### Placement boundary

- [ ] `Phase 3.1`: actor lookup is one function
      (`directory.resolve(id) → ActorHost`). No code reaches into
      the in-process `Map` directly.
- [ ] `Phase 5.x`: HTTP/WS handlers don't bypass the directory.
- [ ] `Phase 9 ready`: swapping the directory implementation from
      "single node" to "consistent-hash + RPC" requires no changes
      outside `runtime/directory.ts`.

### Fencing token

- [ ] `Phase 2`: `actor:<id>:fence` key reserved (declared in
      layout); `actor_snapshot.seq` is monotonic per actor.
- [ ] `Phase 3.1`: `ActorHost.activate` reads/writes a token via
      the driver even though v1 always has a single owner. The
      token is just `0` and never incremented; v2 starts using it.
- [ ] `Phase 9 ready`: writes with stale tokens are refused at the
      driver boundary in v1 too (cost: a noop check; benefit:
      cluster correctness without runtime changes).

### Idempotency keyed for retry

- [ ] `Phase 5.1`: every mutating route accepts `Idempotency-Key`
      and the driver dedupes. v2 reuses this for caller retries
      across redirects.

### Mailbox is process-local but the inbox is shared

- [ ] `Phase 3.1`: `tell` writes to `actor:<id>:inbox` (Valkey
      stream) before in-memory enqueue. v2 can replay the stream
      on the new owner after a hand-off.

### Manifest pinning is request-scoped

- [ ] `Phase 4`: `Manifest` lives in `ctx.manifest` and is threaded
      through every cross-actor call. v2 propagates it across nodes
      in the same envelope field.
- [ ] `Phase 5.2`: WS manifest pin is per-connection. A redirect to
      a new node carries the pin via the upgrade.

### Reminders durability

- [ ] `Phase 3.3`: dispatcher key is configurable. v2 shards by
      time bucket; v1 sets it to `reminders`.
- [ ] PG mirror of reminders exists.

### Storage driver is the boundary

- [ ] `Phase 2`: no code outside `storage/` imports `pg` or `redis`
      directly. v2 adds a `cluster-aware` driver implementation
      without changing call sites.

---

## Implementation tasks (broken out when v2 starts)

The following are _not_ sized in this task. Each becomes its own
task with checklist + ADR when the cluster work is greenlit:

- **9.1 — Membership.** Valkey-backed leader election or external
  etcd/Raft. Cluster identity, node liveness, gossiped placement
  table.
- **9.2 — Placement.** Consistent hashing on `actorId`; per-node
  ownership claim with fencing token bump on activate.
- **9.3 — Cross-node RPC.** Internal protocol between nodes for
  `dispatch(envelope)`. Reuse the wire types from Phase 5.
- **9.4 — Hot migration.** Drain mailbox, snapshot, hand-off,
  resume. Coordination with subscribers (5.2) so they reconnect to
  the new owner.
- **9.5 — Client routing.** Nodes redirect (`307`) or proxy on miss.
  SDK caches resolved-node per actor with TTL.
- **9.6 — Operational story.** Rolling upgrades, partial-partition
  detection, fencing-token reset procedure.

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
