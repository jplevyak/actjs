# ADR — Phase 5.2: WebSocket / JSON-RPC

> Task: [phase-5-2-websocket-jsonrpc.md](./phase-5-2-websocket-jsonrpc.md)
> Plan reference: [PLAN.md § Phase 5b](../PLAN.md#phase-5--api-surface-fastify)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Real-time subscriptions are the differentiator between this and a
plain REST + polling backend. Decisions here bind the SDK and the
fanout characteristics of every hot actor._

## Decision

Likely decisions to settle here:

### JSON Patch library

- Options: `fast-json-patch`, `rfc6902`, hand-rolled.
- Choice: _TBD_

### Patch-vs-snapshot threshold

- Options: patch always, snapshot if patch > snapshot size,
  snapshot if patch > X bytes.
- Choice: _TBD_

### Heartbeat cadence

- Options: 15 s / 30 s / 60 s, with proportional timeout.
- Choice: _TBD_

### Per-actor subscriber cap

- Options: 100, 1000, 10000.
- Choice: _TBD_

### Per-subscriber buffer policy

- Options: drop-oldest, drop-newest, close-on-overflow.
- Choice: _TBD_

### Reconnect/replay window

- Options: 30 s, 5 min, configurable per class.
- Choice: _TBD_

## Consequences

### Positive
- _TBD_

### Negative / trade-offs
- _TBD_

### Follow-ups for later phases
- _TBD_

## Alternatives considered (and why not)

- _TBD_

## References

- _TBD_
