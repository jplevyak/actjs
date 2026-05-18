# Phase 8.1 — Observability

> Source: [PLAN.md § Phase 8a](../PLAN.md#phase-8--observability--dx)
> Decisions: [phase-8-1-observability.adr.md](./phase-8-1-observability.adr.md)

## Goal

Make actjs operable: structured logs, OpenTelemetry traces propagated
through actor-to-actor calls, Prometheus metrics with cardinality
guards, and a default Grafana dashboard bundle.

## Done when

- A request to `/v1/actors/.../call` produces one HTTP span, one
  mailbox span, and one PG span — all linked by trace-id.
- `actor_message_total` correctly increments per call;
  `clients_by_manifest` reflects active pins.
- `ops/grafana/` bundle imports cleanly and shows a populated
  dashboard against a running compose stack.
- A burn-rate alert on `error_rate > 0.1%` and
  `p99 call latency > 250ms` is configured (Prometheus alert rules
  shipped, not a hosted system).

---

## Checklist

### Logs

- [ ] `pino` configured server-wide; one JSON line per event.
- [ ] Common fields injected via child logger:
      `requestId`, `actorId`, `class@version`, `principal.sub`,
      `tenant`, `manifestSha`.
- [ ] Log levels: handlers default to `info`, runtime to `info`,
      driver to `warn`. Configurable via env.
- [ ] Sensitive fields (`Authorization`, `Idempotency-Key`,
      capability JWT body) are filtered out via a serializer.
- [ ] In-test mode: logger pipes to `node:stream` for assertions.

### Traces

- [ ] `@opentelemetry/sdk-node` initialized at boot; auto-
      instrument `pg`, `redis`, `fastify`, `ws`.
- [ ] Manual spans:
  - [ ] One per HTTP/WS request.
  - [ ] One per mailbox turn.
  - [ ] One per actor-to-actor `call` / `tell`.
- [ ] W3C trace-context propagated in `Envelope.causation` chains.
- [ ] Sampling: parent-based + 1% tail by default; configurable.
- [ ] Span-kind allow-list to prevent runaway attribute cardinality.

### Metrics

- [ ] `prom-client` registry exposed at `/metrics`.
- [ ] Implemented:
  - [ ] `actor_message_total{class, method, outcome}`.
  - [ ] `actor_mailbox_depth{class}` gauge.
  - [ ] `actor_active{class, version}` gauge.
  - [ ] `clients_by_manifest{sha}` gauge (4.3 wired the data
        source).
  - [ ] `manifest_resolution_seconds` histogram.
  - [ ] `event_append_total{class}` counter.
  - [ ] `event_snapshot_total{class}` counter.
  - [ ] `policy_decision_total{class, decision}` (from 7.1).
  - [ ] `rate_limit_drop_total{principal}` (from 7.2).
- [ ] Allow-list for the `method` label; unknown method → `_other`.
- [ ] Standard Node + PG-pool + Valkey-client collectors registered.

### Dashboards & alerts

- [ ] `ops/grafana/dashboards/`:
  - [ ] `actjs-overview.json`: throughput, p50/p99 latency, error
        rate, mailbox depth, active actors.
  - [ ] `actjs-per-class.json`: same metrics broken down by class.
  - [ ] `actjs-versions.json`: clients-by-manifest, deprecated
        version usage.
- [ ] `ops/prometheus/alerts.yml`:
  - [ ] `HighErrorRate` (multi-window burn rate).
  - [ ] `HighP99Latency`.
  - [ ] `MailboxBackpressure`.
  - [ ] `DeprecatedVersionStillUsed`.
- [ ] Compose stack adds a Prometheus + Grafana service for local
      experimentation (off by default; `compose -f compose.yml -f
compose.observability.yml`).

### SLO definitions

- [ ] `ops/slos.yml` records target SLOs (latency, error rate,
      uptime). Burn-rate alerts derive from it.
- [ ] README links from the operator-facing docs.

### Tests

- [ ] Integration test: make N calls, scrape `/metrics`, assert
      counter increments.
- [ ] Trace propagation: a call from actor A to actor B shares a
      trace-id (asserted against an in-process OTel exporter).
- [ ] Cardinality guard: a flood of distinct method names doesn't
      explode the metrics endpoint size.

---

## Risks & watch-outs

- [ ] OTel SDK upgrades are notoriously breaking. Pin firmly and
      record the upgrade procedure in the ADR.
- [ ] `clients_by_manifest{sha}` is intentionally high-cardinality
      but capped (4.3). Make sure both this gauge and the trace
      attributes respect the same cap.
- [ ] Logs at `info` for every mailbox turn flood quickly. Default
      runtime level might need to be `warn` with `info` opt-in;
      decide in ADR.
- [ ] Dashboards in JSON are awkward to review in PRs. Use Grafonnet
      or a similar generator if it pays off; ADR decides.
- [ ] Alerts that fire too often get muted. Tune thresholds against
      a running deployment before claiming "alerting works."
