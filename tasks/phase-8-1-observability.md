# Phase 8.1 — Observability

> Source: [PLAN.md § Phase 8a](../PLAN.md#phase-8--observability--dx)
> Decisions: [phase-8-1-observability.adr.md](./phase-8-1-observability.adr.md)

## Goal

Make actjs operable: structured logs, OpenTelemetry traces propagated
through actor-to-actor calls, Prometheus metrics with cardinality
guards, and a default Grafana dashboard bundle.

**Scope this phase:** logs + metrics. OTel traces, Grafana JSON, and
the Prometheus alert bundle defer to 8.1b — see the ADR.

## Done when

- [x] A call to `/v1/actors/.../<method>` records one
      `actjs_actor_message_total` increment per outcome class.
- [x] `clients_by_manifest{sha}` reflects active pins via the
      manifest tracker.
- [ ] `ops/grafana/` bundle imports cleanly and shows a populated
      dashboard against a running compose stack. _(Deferred to
      8.1b; metric names are stable so the bundle can be added
      without touching call sites.)_
- [ ] A burn-rate alert on `error_rate > 0.1%` and
      `p99 call latency > 250ms` is configured. _(Deferred to 8.1b
      alongside the Grafana bundle.)_

---

## Checklist

### Logs

- [x] `pino` configured server-wide; one JSON line per event.
- [x] Common fields injected via child logger:
      `requestId`, `actorId`, `class@version`, `principal.sub`,
      `tenant`, `manifestSha`.
- [x] Log levels: handlers / runtime / server default to `info`,
      driver to `warn`. Configurable via `ACTJS_LOG_LEVEL` (global)
      and `ACTJS_LOG_LEVEL_<SUBSYSTEM>` (per subsystem).
- [x] Sensitive fields (`Authorization`, `Idempotency-Key`,
      `x-actjs-admin`, capability JWT) filtered via pino redact.
- [x] In-test mode: `makeCollectingLogger` records events into an
      array for assertions; `makeNoopLogger` is the default in
      `NODE_ENV=test`.

### Traces

- [ ] `@opentelemetry/sdk-node` initialized at boot. _(Deferred —
      8.1b.)_
- [ ] Manual spans (HTTP/WS request, mailbox turn, actor-to-actor
      call). _(Deferred.)_
- [ ] W3C trace-context propagated in `Envelope.causation` chains.
      _(Deferred.)_
- [ ] Sampling: parent-based + 1% tail by default; configurable.
      _(Deferred; choice locked in ADR.)_
- [ ] Span-kind allow-list to prevent runaway attribute
      cardinality. _(Deferred.)_

### Metrics

- [x] `prom-client` registry exposed at `/metrics`.
- [x] Implemented:
  - [x] `actjs_actor_message_total{class, method, outcome}`.
  - [x] `actjs_actor_mailbox_depth{class}` gauge (operator-driven
        setter exists; auto-updater lands with a watchdog in 8.2).
  - [x] `actjs_actor_active{class, version}` gauge.
  - [x] `actjs_clients_by_manifest{sha}` gauge.
  - [x] `actjs_manifest_resolution_seconds` histogram (operator-
        driven `observe` API; the pin hook call site is wired in
        8.1b alongside the OTel histogram).
  - [x] `actjs_event_append_total{class}` counter.
  - [x] `actjs_event_snapshot_total{class}` counter.
  - [x] `actjs_policy_decision_total{class, decision}`.
  - [x] `actjs_rate_limit_drop_total{subject}`.
  - [x] `actjs_capacity_exhausted_total{class}`.
  - [x] `actjs_capability_minted_total{class}`.
- [x] Allow-list for the `method` label; unknown method → `_other`.
- [x] Standard Node + process collectors registered by default
      (`collectDefault: false` to disable).

### Dashboards & alerts

- [ ] `ops/grafana/dashboards/`. _(Deferred — 8.1b.)_
- [ ] `ops/prometheus/alerts.yml`. _(Deferred — 8.1b.)_
- [ ] `compose.observability.yml`. _(Deferred — 8.1b.)_

### SLO definitions

- [ ] `ops/slos.yml` records target SLOs. _(Deferred — 8.1b.)_
- [x] `docs/observability.md` documents starter PromQL queries the
      operator can paste into Grafana ahead of the bundle.

### Tests

- [x] Integration: N calls increment `actjs_actor_message_total`
      with the right labels; rate-limit-denied call records
      `outcome="rate_limited"`.
- [ ] Trace propagation. _(Deferred with OTel.)_
- [x] Cardinality guard: 20 distinct methods cap at `methodLimit + 1` series via the `_other` bucket.
- [x] Logger: JSON shape, child field merge, redaction.

### Documentation

- [x] `docs/observability.md` — operator-facing runbook (logs,
      metrics, redacted fields, scrape config, starter alerts).

---

## Risks & watch-outs

- [x] Logs at `info` for every mailbox turn flood quickly. _(Driver
      defaults to `warn`; runtime stays at `info`. Per-subsystem
      envs let operators tune without code changes.)_
- [x] `clients_by_manifest{sha}` is intentionally high-cardinality
      but capped (4.3 + manifest tracker's `_other` bucket).
- [ ] OTel SDK upgrades are notoriously breaking. _(Deferred; ADR
      records the trigger to pin firmly when it lands.)_
- [ ] Dashboards in JSON are awkward to review. _(Deferred; the
      ADR locks raw JSON as the format.)_
- [ ] Alerts that fire too often get muted. _(Deferred; starter
      queries documented in `docs/observability.md` until the
      bundle ships.)_
