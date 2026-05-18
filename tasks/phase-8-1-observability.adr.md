# ADR — Phase 8.1: Observability

> Task: [phase-8-1-observability.md](./phase-8-1-observability.md)
> Plan reference: [PLAN.md § Phase 8a](../PLAN.md#phase-8--observability--dx)

- **Status:** Proposed
- **Date:** _TBD_
- **Decider(s):** _TBD_

## Context

_Self-hosted operators choose their own vendor; what actjs owns is
the shape of the data and the dashboard/alert defaults. Decisions
here govern operability for the lifetime of the project._

## Decision

Likely decisions to settle here:

### Default log level

- Options: `info`, `warn`, configurable per subsystem.
- Choice: _TBD_

### Trace sampling default

- Options: 1%, 5%, head-based 100%, tail-based, configurable.
- Choice: _TBD_

### Dashboards in JSON vs Jsonnet

- Options: raw JSON committed, Grafonnet/Jsonnet, both.
- Choice: _TBD_

### OTel exporter default

- Options: OTLP/HTTP (vendor-neutral), OTLP/gRPC, none (operator
  configures).
- Choice: _TBD_

### Metrics endpoint auth

- Options: open, basic auth, IP allow-list, behind reverse proxy
  only.
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
