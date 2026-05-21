# ADR — Phase 8.1: Observability

> Task: [phase-8-1-observability.md](./phase-8-1-observability.md)
> Plan reference: [PLAN.md § Phase 8a](../PLAN.md#phase-8--observability--dx)

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider(s):** John Plevyak

## Context

Phase 8.1 covers four observability surfaces in the original task:
logs, traces (OTel), metrics, and Grafana dashboards / Prometheus
alert rules. The scope picked for this phase is **logs + metrics**;
OTel + Grafana JSON + alert rules + the compose observability
service all defer to **8.1b**.

The scope reduction is deliberate. The OTel SDK pulls in 6+
peer-dependency packages and has notoriously breaking minor
upgrades. The Grafana dashboard JSON files are awkward to review
in PRs and need iteration against a running deployment to be
useful. Both deserve their own ADR.

## Decisions

### Default log level — **per-subsystem, env-driven, info default**

`handler` / `runtime` / `server` / `audit` default to `info`;
`driver` defaults to `warn` because the storage hot path generates
chatty events that overwhelm an `info` log volume. Each subsystem
has an explicit env override (`ACTJS_LOG_LEVEL_<SUBSYSTEM>`); the
global `ACTJS_LOG_LEVEL` applies to all subsystems.

**Rationale:** the same actor traffic shape produces vastly
different "interesting" event rates per subsystem. A single global
default is wrong for at least one of them.

### Logging library — **pino with a thin Logger interface**

The codebase imports `Logger` from `src/log/`, not pino directly.
This means tests can substitute a buffered collector
(`makeCollectingLogger`) without re-importing pino, and a future
swap-out (to console, to a vendor SDK) doesn't ripple through every
call site.

### Default log destination — **stdout JSON, one event per line**

No pretty-print, no transports by default. Operators ship logs by
piping stdout to their log aggregator — pino-pretty is opt-in via
`makeLogger({ pretty: true })`.

### Redaction — **deny-list at the pino layer**

`authorization`, `Authorization`, `x-actjs-admin`,
`idempotency-key`, `capability` paths are stripped with
`[redacted]`. The list lives in `src/log/index.ts`; adding a new
sensitive header requires touching one file and updating this ADR.

### Metrics library — **prom-client with a thin MetricsRegistry**

Same shape as the logger: the codebase imports `MetricsRegistry`
from `src/metrics/`, not prom-client. `recordCall`,
`recordActivation`, etc. encapsulate label-set construction so the
cardinality guard lives in exactly one place.

### Method-label allow-list — **first-N per class then `_other`**

Default cap is 50 distinct method names per class. The cap is
process-lifetime — there's no eviction, on purpose, because eviction
makes scrape diffs noisier than the long-tail bucket they'd
prevent. Operators who hit the cap see a single warn line and a
growing `_other` series.

### `/metrics` auth — **open by default**

The endpoint is registered automatically when the runtime has a
real `MetricsRegistry`. It's intentionally open so reverse-proxy
deployments don't need extra plumbing. Operators that need auth
either wrap the route with their `auth` preHandler or expose
`/metrics` on a separate internal listener.

**Rationale:** prom-client text is non-sensitive (no payloads,
allow-listed labels), and any auth on the endpoint creates
operational risk if the credential expires silently.

### Trace sampling, OTel exporter, Grafana JSON, alert bundle — **all deferred to 8.1b**

The task ADR captures these as locked-for-later: parent-based + 1%
tail sampling, OTLP/HTTP exporter, raw JSON dashboards (Grafonnet
overhead doesn't pay back for actjs-scale dashboards). They're
recorded here so 8.1b doesn't re-litigate them.

## Consequences

### Positive

- Logs are immediately useful in production: structured, redacted,
  queryable by `requestId` / `actorId` / `class@version`.
- Metrics are immediately useful: the canonical actor counters land
  in `/metrics` with no plumbing beyond passing a registry to the
  Runtime.
- No new heavy peer dependencies. `pino` and `prom-client` are
  small, well-trodden, and easy to swap if the project ever needs
  to.
- The `Logger` and `MetricsRegistry` interfaces are stable, so the
  8.1b OTel + dashboard work won't touch call sites.

### Negative / trade-offs

- No distributed traces yet — debugging cross-actor `call` /
  `tell` chains relies on shared `causationId` + grep until 8.1b
  lands the OTel SDK.
- No shipped dashboard bundle — operators provision their own
  starter dashboards. The metric names are stable, so curated
  starter queries can be added in `docs/observability.md` ahead
  of 8.1b.
- Open `/metrics` requires operators to either accept the public
  exposure (acceptable for prom-client text) or layer their own
  auth.

### Follow-ups for later phases

- 8.1b: OpenTelemetry SDK (`@opentelemetry/sdk-node`), W3C trace-
  context propagation in `Envelope.causation`, Grafana JSON
  bundle, Prometheus alert rules, `compose.observability.yml`.
- 8.2: `actctl metrics tail` reads `/metrics` and renders a
  human-friendly view.

## Alternatives considered (and why not)

- **Single-shot OTel SDK in this phase.** Too much breakable
  surface area for one PR — the SDK + autoinstrumentation +
  exporter choices each merit their own ADR.
- **Bunyan / Winston instead of pino.** Pino is the fastest JSON
  logger in the Node ecosystem and the Fastify default. Switching
  for ergonomic reasons isn't a win.
- **Manual histograms instead of `prom-client` defaults.** The
  default 8-bucket histogram (0.001 → 5 s) covers the manifest
  resolution range; tuning is a 8.1b dashboard concern, not a
  code concern.
- **Auth required on `/metrics`.** Adds a credential to rotate
  and a failure mode (silent expiry) for negligible security
  win.

## References

- `src/log/` — `Logger`, `makeLogger`, `makeCollectingLogger`,
  redact list, subsystem env vars.
- `src/metrics/` — `MetricsRegistry`, `NoopMetricsRegistry`,
  cardinality bucketing.
- `src/server/routes/metrics.ts` — `/metrics` route handler.
- `docs/observability.md` — operator runbook + scrape config +
  starter alert sketches.
