# Observability

Phase 8.1 ships the two pieces an operator needs to monitor an actjs
server in production:

1. **Structured logs** — pino-backed JSON, one event per line, with
   common fields (`requestId`, `actorId`, `class@version`,
   `principal.sub`, `tenant`, `manifestSha`) injected via child
   loggers.
2. **Prometheus metrics** — a single `MetricsRegistry` exposes
   `/metrics` with canonical actor counters / gauges / histograms
   and built-in cardinality guards.

OpenTelemetry traces, the Grafana JSON bundle, and the Prometheus
alert rule set are deferred to Phase 8.1b (see the ADR).

---

## Logs

```ts
import { makeLogger } from '@jplevyak/actjs/log';
import { buildApp } from '@jplevyak/actjs/server';

const log = makeLogger({ level: 'info' });
const app = await buildApp({ driver, runtime, log });
```

### What you get

- One JSON line per event, written to stdout via pino.
- `requestId`, `actorId`, `class@version`, `principal.sub`,
  `tenant`, `manifestSha` are surfaced as top-level keys by child
  loggers — no string interpolation.
- A `subsystem` field (`server`, `runtime`, `driver`, `handler`,
  `audit`) is set wherever the runtime hands a child logger to a
  subsystem.
- Default level: `info` for handlers / runtime / server, `warn`
  for the driver (chatty hot path otherwise). Each subsystem can
  be overridden via env: `ACTJS_LOG_LEVEL_DRIVER=info`,
  `ACTJS_LOG_LEVEL_HANDLER=warn`, etc. The global override is
  `ACTJS_LOG_LEVEL`.
- Sensitive headers + payload fields (`authorization`,
  `Authorization`, `x-actjs-admin`, `idempotency-key`,
  `capability`) are stripped via pino's `redact` and replaced with
  `[redacted]`.

### Per-request logger

Inside a Fastify route handler:

```ts
async (req, reply) => {
  req.actjsLog?.info('handling create', { class: 'Note' });
};
```

The `req.actjsLog` child carries `requestId` (Fastify-generated).
Add more fields via `req.actjsLog?.child({...})` if the request
fans out.

### In tests

The harness builds a noop logger by default (`NODE_ENV=test` or
`VITEST=1`). Tests that assert on log events use
`makeCollectingLogger` from `actjs/log`:

```ts
import { makeCollectingLogger } from '@jplevyak/actjs/log';

const events: CollectedEvent[] = [];
const log = makeCollectingLogger(events);
const app = await buildApp({ ...rest, log });
```

---

## Metrics

```ts
import { MetricsRegistry } from '@jplevyak/actjs/metrics';
import { ManifestUsageTracker } from '@jplevyak/actjs/server';

const metrics = new MetricsRegistry();
const runtime = new Runtime(driver, { metrics });
const app = await buildApp({
  driver,
  runtime,
  tracker: new ManifestUsageTracker({ metrics }),
});
// GET /metrics now returns Prometheus text.
```

### What's exported

| Metric                              | Type      | Labels                       | Notes                                                                                                |
| ----------------------------------- | --------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `actjs_actor_message_total`         | counter   | `class`, `method`, `outcome` | `outcome ∈ {ok, error, denied, rate_limited, cap_exhausted}`. Method label allow-listed (see below). |
| `actjs_actor_active`                | gauge     | `class`, `version`           | Bumped on activation, decremented on evict / shutdown.                                               |
| `actjs_actor_mailbox_depth`         | gauge     | `class`                      | Set by the metrics tracker (operator-driven; see Phase 8.2 for the polling job).                     |
| `actjs_clients_by_manifest`         | gauge     | `sha`                        | Populated by `ManifestUsageTracker` on every pinned request. `_other` bucket beyond the cap.         |
| `actjs_manifest_resolution_seconds` | histogram | _none_                       | Resolution time for `X-Actjs-Manifest` pins (operator-driven; phase 4.3 has the call site).          |
| `actjs_event_append_total`          | counter   | `class`                      | Bumped per appended event row.                                                                       |
| `actjs_event_snapshot_total`        | counter   | `class`                      | Bumped per flush.                                                                                    |
| `actjs_policy_decision_total`       | counter   | `class`, `decision`          | `decision ∈ {allow, deny}`. From Phase 7.1.                                                          |
| `actjs_rate_limit_drop_total`       | counter   | `subject`                    | From Phase 7.2.                                                                                      |
| `actjs_capacity_exhausted_total`    | counter   | `class`                      | From Phase 7.2.                                                                                      |
| `actjs_capability_minted_total`     | counter   | `class`                      | From Phase 7.1 — bridge mint path.                                                                   |

Plus the standard Node + GC + event-loop collectors that
`prom-client` registers by default. Disable with
`new MetricsRegistry({ collectDefault: false })`.

### Cardinality guards

The `method` label has unbounded user-provided cardinality at the
edge. The registry keeps the first **50** distinct method names
**per class**; anything beyond bucketizes to `method="_other"`.
Adjust with `new MetricsRegistry({ methodLimit: N })`. The first
overflow logs a warn line if a logger is wired:

```
metrics: method-label cardinality cap hit; bucketing into "_other"
```

The `clients_by_manifest{sha}` gauge has its own cap inside
`ManifestUsageTracker` (default 128 shas; overflow goes to
`sha="_other"`).

### Scraping

The `/metrics` endpoint is registered automatically when the
`Runtime` is built with a real `MetricsRegistry`. It's intentionally
**open** — operators behind a reverse proxy or network policy don't
need extra auth and `prom-client` text is non-sensitive. Operators
who need auth can wrap the route with their `auth` preHandler or
expose `/metrics` on a separate internal listener.

A typical Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: actjs
    metrics_path: /metrics
    static_configs:
      - targets: ['actjs.internal:8080']
```

### Suggested alerts (sketch)

Until the formal alert bundle lands in 8.1b, the operator-curated
starter set:

```promql
# Error budget: > 0.1% errors over 5m.
sum by (class) (rate(actjs_actor_message_total{outcome="error"}[5m]))
  /
sum by (class) (rate(actjs_actor_message_total[5m]))
  > 0.001

# Rate limit denials > 1/s for any subject.
sum by (subject) (rate(actjs_rate_limit_drop_total[1m])) > 1

# Activations refused.
rate(actjs_capacity_exhausted_total[5m]) > 0
```

---

## Operator notes

- **Logs without metrics** is supported (`new Runtime(driver, { log })`
  with no metrics) — the `/metrics` route stays unregistered.
- **Metrics without logs** is supported (`new Runtime(driver, { metrics })`
  with no log) — the runtime / bridge fall back to a noop logger.
- **Test isolation**: `MetricsRegistry` constructs its own
  `prom-client` `Registry`. Multiple instances per process don't
  share label state. Tests that build several Runtimes use one
  registry per Runtime to keep counters isolated.
- **prom-client default collectors** add ~30 series per process. If
  your scrape budget is tight, disable them with `collectDefault:
false` and add the collectors you actually want explicitly.
