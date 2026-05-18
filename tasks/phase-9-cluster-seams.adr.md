# ADR — Phase 9: Cluster seams (deferred)

> Task: [phase-9-cluster-seams.md](./phase-9-cluster-seams.md)
> Plan reference: [PLAN.md § Phase 9](../PLAN.md#phase-9--cluster-sketch-only-deferred)

- **Status:** Proposed (deferred — only the seams are committed in v1)
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_v1 ships single-node. This ADR records the cluster-shaped decisions
made *passively* during earlier phases (driver boundary, fencing
slot, in-stream durability, manifest plumbing) so they're discoverable
and not accidentally undone. The active cluster decisions (membership
algorithm, placement policy, RPC framing) are out of scope until v2._

## Decision

Seams committed in v1 (verified by the review checklist in the task):

- The storage-driver interface is the only path to durable state.
- `actor:<id>:fence` is reserved in Valkey; snapshot rows carry a
  monotonic seq that v2 will treat as a token surrogate.
- `actor:<id>:inbox` is a durable Valkey stream; in-memory mailbox is
  a cache.
- Manifest pin is carried in the envelope and request context so it
  survives cross-node hops without re-resolving.
- Reminders dispatcher key is configurable so v2 can shard.

Active cluster decisions deferred to v2:

### Membership algorithm

- Options: Valkey-backed leader election, etcd/Raft, hash-of-static-
  membership.
- Choice: _v2_

### Placement algorithm

- Options: consistent hashing, rendezvous hashing, range-based.
- Choice: _v2_

### Cross-node RPC

- Options: HTTP/2 with the same wire types, gRPC, custom binary.
- Choice: _v2_

### Subscription fanout plane

- Options: Valkey pub/sub, NATS, custom mesh.
- Choice: _v2_

### Hot-migration coordination

- Options: drain-stop-handoff, optimistic dual-ownership with
  fencing, no automatic migration.
- Choice: _v2_

## Consequences

### Positive

- _TBD_

### Negative / trade-offs

- _TBD_

### Follow-ups when v2 starts

- Convert each "9.x — ..." line in the task to its own task + ADR.

## Alternatives considered (and why not)

- _TBD_

## References

- _TBD_
