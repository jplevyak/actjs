# ADR — Phase 9: Cluster seams (deferred)

> Task: [phase-9-cluster-seams.md](./phase-9-cluster-seams.md)
> Plan reference: [PLAN.md § Phase 9](../PLAN.md#phase-9--cluster-sketch-only-deferred)

- **Status:** Accepted (seams committed in v1; active cluster decisions still deferred)
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

v1 ships single-node. This ADR records the cluster-shaped decisions
made _passively_ during earlier phases (driver boundary, fencing
slot, in-stream durability, manifest plumbing) so they're
discoverable and not accidentally undone. The 2026-05-20 audit
walked the checklist and closed three real gaps with minimum
invasive changes; the active cluster decisions (membership
algorithm, placement policy, RPC framing) remain out of scope until
v2.

## Decisions

### Seams committed in v1

- **Storage driver is the only path to durable state.** Verified by
  audit: no non-storage code imports `pg` or `redis`. The legacy
  GAct shim (`src/gact.ts`) does import `redis`, but lives outside
  the actor framework and is documented for sunset in PLAN.md.

- **`actor:<id>:fence` key is reserved in Valkey** (`storage/keys.ts`)
  and an `actor.fence` bigint column lands via migration
  `0004_actor_fence.up.sql`. `actor_snapshot.seq` remains monotonic
  per actor.

- **Fence-token plumbing.** Driver gained:
  - `loadActorFence(id): Promise<bigint>` — default 0.
  - `bumpActorFence(id, expected): Promise<bigint>` — atomic CAS;
    throws `StaleFenceTokenError` on mismatch.
  - `saveSnapshot(id, snap, expectedFence?)` and
    `appendEvents(id, events, expectedFence?)` validate against
    the stored fence when the argument is supplied.

  `ActorHost.activate` reads the fence (always `0n` in v1) and
  stashes it; every subsequent `appendEvents` / `saveSnapshot`
  passes the stashed value. v2 placement starts calling
  `bumpActorFence` on ownership claim — at which point a stale
  owner's writes start failing without further runtime changes.

- **`actor:<id>:inbox` is a durable stream;** in-memory mailbox is
  a cache. `ActorHost.tell` appends to the inbox before in-memory
  enqueue; `ActorHost.activate` replays pending inbox entries.

- **Manifest pin carried in envelope + request context.** Wire
  transports (REST, WS) attach the pin to the request; the WS
  route now captures `req.manifestPin` per-connection so a
  redirect to a v2 node can carry it through the upgrade.

- **Reminders dispatcher key is configurable.** `ValkeyPgOptions`
  accepts `remindersKey?: string` — v2 cluster sharding swaps the
  default `'reminders'` for a per-time-bucket scheme without
  touching the dispatcher.

- **PG mirror of reminders** (`migrations/0002_reminders.up.sql`).

### Documented v2 gap

- **In-process cross-actor manifest propagation.** `actjs.call(ref,
...)` inside a handler does not propagate the request's manifest
  pin. The bridge doesn't have per-call context — fixing this
  needs either AsyncLocalStorage (Node-only, slight perf cost) or
  a threaded `ctx` argument on every call site. v1 single-node
  doesn't observe the gap because every handler runs in the same
  process under the same registered class version. v2 lands the
  fix as task 9.7.

### Active cluster decisions deferred to v2

#### Membership algorithm

- Options: Valkey-backed leader election, etcd/Raft,
  hash-of-static-membership.
- Choice: _v2_

#### Placement algorithm

- Options: consistent hashing, rendezvous hashing, range-based.
- Choice: _v2_

#### Cross-node RPC

- Options: HTTP/2 with the same wire types, gRPC, custom binary.
- Choice: _v2_

#### Subscription fanout plane

- Options: Valkey pub/sub, NATS, custom mesh.
- Choice: _v2_

#### Hot-migration coordination

- Options: drain-stop-handoff, optimistic dual-ownership with
  fencing, no automatic migration.
- Choice: _v2_

## Consequences

### Positive

- The fence-token + reminder-key + WS-pin gaps are closed at
  driver + transport layers without committing to any v2 algorithm
  choice. A future v2 PR can land placement + ownership-claim with
  no runtime or transport rewrites — only the directory layer
  changes.
- The `StaleFenceTokenError` contract is testable today
  (`tests/cluster-seams/fence.test.ts` exercises it against the
  memory driver) so v2 work has a regression net before it starts.
- The Phase 9 checklist now reflects the actual state of the
  codebase; future audits start from "all clean" instead of
  re-deriving what's clean and what isn't.

### Negative / trade-offs

- Every snapshot/event write incurs a fence-token argument and an
  optional validation read against the stored fence. In v1 the
  argument is `0n` and the read is `O(1)` (Map lookup in memory,
  one extra row read for PG). The cost is real but small; the v2
  win — refusing stale writes without ever editing the runtime —
  is much larger.
- The in-process cross-actor manifest gap is documented but
  unfixed. Anyone hitting it today already has a workaround
  (handlers can read the pin off `this.actjs` if we expose it),
  but the proper fix is a v2 task.

### Follow-ups when v2 starts

- Convert each "9.x — ..." line in the task to its own task + ADR.
- 9.2 (Placement) is the natural first task: it wires up
  `bumpActorFence` on ownership claim, at which point everything
  the v1 seam committed starts paying off.

## Alternatives considered (and why not)

- **Required fence argument on every write.** Would force every
  test that exercises the driver directly to wire a fence in.
  Optional with default-skip preserves the test surface; the host
  always provides it, so v1 production paths still get the
  enforcement.
- **Move the fence to the snapshot row instead of the actor row.**
  Snapshots are immutable per-seq; the fence is a per-actor
  property tied to ownership, not to a specific write. The actor
  row is the right home.
- **Make the WS handler proxy the manifest pin into every JSON-RPC
  call.** v1 has nothing to do with the captured pin; capturing
  it is the seam (v2 routing can read it). Doing more than capture
  would be speculative work.
- **Skip the fence implementation, just document the gap.** Tested
  by trying it: documenting "we need fences for v2" doesn't
  protect against accidental changes that make v2 harder to land.
  A noop check on every write is the cheapest way to lock in the
  contract.

## References

- `src/storage/driver.ts` — `loadActorFence`, `bumpActorFence`,
  `StaleFenceTokenError`.
- `src/storage/memory.ts`, `src/storage/valkey-pg.ts` — driver
  implementations + the fence-aware `saveSnapshot` /
  `appendEvents` overloads.
- `src/runtime/host.ts` — `ActorHost.activate` stashes the
  fence; flush + appendEvents pass it back.
- `migrations/0004_actor_fence.up.sql` — PG schema delta.
- `tests/cluster-seams/fence.test.ts` — driver-level coverage of
  the fence semantics + end-to-end smoke through `TestRuntime`.
- `src/server/routes/ws.ts` — captures `req.manifestPin`
  per-connection alongside `req.principal`.
- `src/storage/valkey-pg.ts` — `ValkeyPgOptions.remindersKey`.
