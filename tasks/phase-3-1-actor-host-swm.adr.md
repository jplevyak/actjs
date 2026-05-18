# ADR — Phase 3.1: Actor host (SWM mailbox)

> Task: [phase-3-1-actor-host-swm.md](./phase-3-1-actor-host-swm.md)
> Plan reference: [PLAN.md § Phase 3a/3b](../PLAN.md#phase-3--actor-runtime)

- **Status:** Accepted
- **Date:** 2026-05-18
- **Decider(s):** project author

## Context

The SWM runtime is the hot path for every actor that isn't event-
sourced. Latency, correctness, and durability here dominate the
user-visible behavior. Decisions made now bind Phase 3.2 (event
sourcing), Phase 3.3 (reminders / migrations), and the cluster
extension in Phase 9.

Constraints carried in:

- Phase 1 base types (`Actor<S>`, `@handler` registry) are the
  contract.
- Phase 2's `StorageDriver` interface is the durability boundary.
  This phase extends it with an inbox stream (the only ES-style
  primitive a SWM actor needs).
- The memory driver lets the entire runtime be unit-tested without
  any external infra; valkey-pg parity is enforced by the
  conformance suite from Phase 2.

## Decision

### Mailbox implementation — **hand-rolled bounded queue**

A ~80-line `Mailbox` class with capacity check, single-consumer
worker, and a small waiter list for empty-queue blocking. Reasons:

- Zero new dependencies. `p-queue` is fine but pulls in concurrency
  features we don't use; the surface we need is small enough that
  owning it is cheaper.
- The mailbox is the single hottest object in the runtime. Tight
  control over allocations and timing matters; debugging through a
  third-party queue is a frequent source of pain.
- The wire-protocol contract — one consumer, drop-on-overflow for
  `tell`, reject-on-overflow for `call` — doesn't map cleanly onto
  a general queue library's options.

### Inbox stream durability — **write-before-enqueue**

Every `tell` writes to `actor:<id>:inbox` (Valkey Stream in
production; in-memory array in the test driver) _before_ it lands
on the in-memory queue. On handler success the entry is acked;
on crash, the next activate replays unacked entries.

Reasons:

- A crash between in-memory enqueue and inbox write would lose the
  message under the alternative. We pay the latency cost (one extra
  storage round-trip per `tell`) for guaranteed durability.
- `call` does NOT touch the inbox — the caller retries.

### Idle deactivation timer — **5 min default, per-class override**

Long enough that a chatty browser session keeps an actor warm
across human-think-time gaps. Short enough that a process with
thousands of idle actors deactivates them in a reasonable window.
Per-class override (`idleDeactivateMs` on the class metadata)
exists for unusual cases (very expensive cold starts, single-use
actors).

### Snapshot debounce window — **250 ms trailing**

Coalesces a burst of writes into one snapshot. 250 ms is short
enough that a graceful shutdown after a recent write flushes
without operator-visible delay, and long enough that a hot loop of
10k tells produces a small number of physical writes.

### Activation rate cap — **none in v1**

The plan called out activation storms as a risk. For self-hosted
v1 we trust the operator: a single Node process activating 100k
distinct actors in a tight loop will OOM, but that's an operator
test failure, not a framework bug. The directory's `materializing`
map prevents _double_-activation, which is the protocol-level
hazard. A throttle can land in Phase 9 if real workloads need it.

### Drop-on-cap policy for `tell` — **drop after durable write**

When the mailbox is at cap and a `tell` arrives, the runtime:

1. Writes the entry to the inbox (durable).
2. Acks the entry immediately (discards it).
3. Increments `actor_mailbox_drop_total`.

This costs one storage round-trip per dropped tell but keeps the
"never lose a message we accepted" invariant intuitive: every
inbox entry is either in flight, completed, or explicitly
discarded.

`call` over cap throws `MailboxFullError` synchronously — no
durable write needed because the caller will retry (or surface
the 429 to the user).

## Consequences

### Positive

- Zero new dependencies on top of Phase 2.
- The entire runtime can be unit-tested against the memory driver;
  the conformance suite from Phase 2 keeps valkey-pg honest.
- Crash recovery is straightforward: the runtime is stateless above
  the storage layer, so process restart + replay-on-activate gives
  exactly-once-after-recovery semantics for `tell`.

### Negative / trade-offs

- Hand-rolled mailbox means we own its bug surface forever. Mitigated
  by the unit tests in `tests/runtime/mailbox.test.ts`.
- Write-before-enqueue adds one storage round-trip per `tell`. The
  alternative (write-after-ack) is more performant but inverts the
  durability story.
- 250 ms snapshot debounce means a crash within that window after a
  write can lose the change — but the inbox replay covers any tell
  that drove the change, so total state is recoverable.

### Follow-ups for later phases

- Phase 3.2 (ES) reuses the worker loop but commits via
  `appendEvents` + reduce instead of state mutation; the mailbox /
  inbox machinery is unchanged.
- Phase 3.3 wires reminders into the same dispatch path.
- Phase 4.2 plumbs sticky-vs-floating version policy through the
  host's activation; the version field on every snapshot is already
  in place.
- Phase 9 may need to add an activation rate cap; the directory's
  materializing map is the place for it.

## Alternatives considered (and why not)

- **`p-queue` mailbox.** Works, but mixes concurrency with FIFO
  semantics we want clean. The custom mailbox is ~80 lines of code
  vs a dependency that needs upgrading.
- **Write-after-ack durability.** Faster but loses messages in a
  crash window. The framework's primary durability promise should
  be conservative.
- **No idle deactivation.** Trivial to implement, costs memory
  unboundedly. Not viable for self-hosted long-running processes.
- **Per-mailbox-turn snapshot.** Maximum durability, terrible
  throughput on hot loops. 250 ms is a generous compromise; the
  inbox covers the gap.

## References

- PLAN.md § Phase 3a/3b
- tasks/phase-3-1-actor-host-swm.md
- Phase 2 conformance suite (`tests/storage/conformance.ts`)
