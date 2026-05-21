# Roadmap (post-8.2)

Phases 0 through 8.2 ship the framework. This file captures **what
was deferred from each phase** and the recommended order for picking
up the follow-ups. Treat it as a working document: when a follow-up
ships, move it from "queued" to "done" with the date, and add new
follow-ups uncovered during implementation.

The unifying principle for ordering: **production blockers first,
ergonomics last.** Storage drift between memory and PG-backed drivers
strands operators who try to deploy; CLI sugar and dashboard JSON
files are recoverable later.

---

## Suggested order

### Tier 1 — production blockers (storage parity)

These close the gap between "works in memory" and "works in
production." Anyone running actjs against a real Postgres / Valkey
deployment hits these before they hit anything else.

1. **7.1b — PG-backed `Blocklist`.** The capability revocation
   blocklist is memory-only today; a single-node restart loses every
   revoke. The interface (`Blocklist` in `src/policy/blocklist.ts`)
   is stable, so this is a swap-in `PgBlocklist` plus the existing
   `CachedBlocklist` wrapper for hot-path reads.

2. **7.2b — PG-backed `SigningKeyRegistry`.** Memory-only registry
   means signed-publish state evaporates on restart. Migration
   `0003_signing_keys.up.sql` already ships; this is the adapter
   class hitting the table.

3. **7.2b — S3 audit mirror (optional).** Append-only mirror behind
   an async queue. Lower priority than the two above because
   strict-mode audit writes already make the PG table the source of
   truth.

### Tier 2 — observability close-out

These complete the operability story so an operator can monitor
without rolling their own dashboards.

4. **8.1b — OpenTelemetry SDK + trace propagation.** OTel SDK pulled
   in 6+ peer deps; pinning + manual spans for HTTP / mailbox /
   actor-to-actor `call`/`tell`. The ADR locks parent-based + 1%
   tail sampling and OTLP/HTTP exporter.

5. **8.1b — Grafana dashboard bundle + Prometheus alert rules.**
   `ops/grafana/dashboards/{actjs-overview,actjs-per-class,actjs-versions}.json`
   plus `ops/prometheus/alerts.yml` (`HighErrorRate`,
   `HighP99Latency`, `MailboxBackpressure`, `DeprecatedVersionStillUsed`).
   Worth doing alongside 8.1b traces because alerts are easier to
   tune when traces are available to triage.

6. **8.1b — `compose.observability.yml`.** Optional Prometheus +
   Grafana service for local experimentation
   (`compose -f compose.yml -f compose.observability.yml`).

### Tier 3 — operator UX (CLI)

These ship once somebody is using the framework day-to-day and feels
the CLI friction. Build them in response to real usage, not
speculatively — watcher and shell ergonomics shift a lot once you
have real users to complain about them.

7. **8.2b — `actctl` consolidation.** Move to `commander` (or
   `clipanion` — ADR-pending), `.actjs/config.toml` + `ACTJS_URL` /
   `ACTJS_TOKEN` env override + `--profile`, `--json` on every
   command. Carry the existing `codegen` / `key add|revoke` /
   `publish` subcommands across the migration.

8. **8.2b — `actctl dev`.** Watch a class directory, debounce
   publishes, push pre-release versions to a running dev server.
   The most-used command — make it fast. `chokidar` is the obvious
   watcher choice; defer the choice to the implementing PR.

9. **8.2b — Remaining subcommands.** `list`, `deprecate`, `promote`,
   `actor inspect`, `actor migrate`, `manifest show`,
   `migrate dry-run` (built on `replayMigrations`), `logs follow`,
   `audit follow`, `shell` (REPL backed by `/v1/run`).

### Tier 4 — developer-test polish

10. **8.2c — Property-test integration.** `fast-check` wrapper as
    `t.property(arbitraries, runner)`; built-in arbitraries
    (`aValidPrincipal`, `aManifest`, `aClassRef`).

### Tier 5 — policy DSL

11. **7.1b — YAML default policy DSL.** Sibling `Class.policy.yaml`
    files compiled to the same `PolicyFn` the runtime already
    accepts. CEL is the leading candidate per the 7.1 ADR; the
    expression-language pick deserves its own ADR.

### Tier 6 — clustering (Phase 9)

12. **9 — Cluster seams.** v1 ships single-node; the
    `phase-9-cluster-seams.md` review checklist has guarded the
    seams across earlier phases. Trigger for actual implementation
    work: enough demand for multi-node deployments. When that
    arrives, break out the items at the bottom of `phase-9-*.md`
    into their own session-sized tasks.

---

## Triggers (not calendar)

Don't pick a date — pick a signal:

- **Tier 1 fires** when somebody attempts a production deployment
  against Postgres + Valkey and reports the memory-only drift.
  Don't speculatively build storage adapters; build them when an
  operator's bug report points at the gap.
- **Tier 2 fires** when somebody is operating actjs and asks
  "where's the dashboard?" Until then, the metric names in
  `docs/observability.md` are stable enough that operators can
  hand-roll starter dashboards.
- **Tier 3 fires** when **you** start using `@actjs/test` plus a
  running server for a real project and want `actctl dev` instead
  of curl-publishing each save. Or when Phase 9 lands and a
  polished CLI is a publish-blocker.
- **Tier 4 fires** when a real `@actjs/test` user wants property
  tests — not before.
- **Tier 5 fires** when somebody has written enough JS `policy()`
  functions to want a declarative DSL and is willing to argue about
  CEL vs CUE vs hand-rolled.
- **Tier 6 fires** when there's actual demand for clustering, not
  a sense that "v1 should support multiple nodes."

---

## Process

When a follow-up ships:

1. Update the parent phase's task file (`tasks/phase-X-Y-*.md`) —
   flip the relevant `[ ]` to `[x]` and remove the `_(Deferred —
X.Yb)_` marker.
2. Add or amend the ADR with the new locked decisions (CEL vs CUE,
   commander vs clipanion, etc.).
3. Move the corresponding line in this roadmap to a
   `## Shipped` section at the bottom, with the date.

When a new follow-up is uncovered:

1. Add it to the parent phase's task file as a `[ ]` with the
   `_(Deferred — X.Yb)_` marker.
2. Append a bullet to the right tier above.

---

## Shipped

_(empty — populate as follow-ups land)_
