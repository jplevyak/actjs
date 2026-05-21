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

12. **9.x — v2 cluster implementation tasks.** The seam audit shipped
    2026-05-20 (see Shipped). The implementation work — placement,
    membership, cross-node RPC, hot migration, client routing,
    operational story, cross-actor manifest propagation — is broken
    out at the bottom of `phase-9-cluster-seams.md`. Each becomes its
    own session-sized task + ADR when v2 starts.

    **Natural entry point:** **9.2 — Placement.** Consistent hashing
    on `actorId` + per-node ownership claim via
    `driver.bumpActorFence(id, expected)` on activate. The fence-token
    plumbing already lands in v1; 9.2 just wires up the caller. From
    there the dependency order is 9.1 (Membership) → 9.3 (RPC) → 9.4
    (Hot migration) → 9.5 (Client routing) → 9.6 (Ops story).

    **9.7 — Cross-actor manifest propagation** is the documented v2
    gap from the audit: in-process `actjs.call(ref, ...)` doesn't
    carry the request's manifest pin. AsyncLocalStorage candidate.

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
  a sense that "v1 should support multiple nodes." The seam audit
  already ran; v2 work starts at 9.2 (Placement) without needing
  another seam pass.

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

- **2026-05-20 — Phase 9 cluster-seam audit + minimum fixes.** Audited
  each of the placement / fencing / idempotency / inbox / manifest /
  reminders / driver-boundary seams against the actual codebase.
  Three real gaps were closed with minimum-invasive changes (no v2
  cluster code):
  - Fence-token plumbing: `StaleFenceTokenError`, driver
    `loadActorFence` / `bumpActorFence`, optional `expectedFence` on
    `saveSnapshot` / `appendEvents`, `ActorHost` stashes the token on
    activate and threads it through every write. Migration
    `0004_actor_fence.up.sql` adds `actor.fence bigint`. The check is
    a noop in v1 single-owner deployments; v2 placement (task 9.2)
    will start bumping and writes from a stale owner will start
    failing without further runtime changes.
  - WS manifest pin captured per-connection alongside `req.principal`.
  - `ValkeyPgOptions.remindersKey` parameterized so v2 sharding can
    substitute a per-time-bucket scheme.

  One documented v2 gap: in-process cross-actor manifest propagation
  (`actjs.call(ref, ...)` inside a handler doesn't carry the
  originating request's pin). Tracked as task **9.7**.
