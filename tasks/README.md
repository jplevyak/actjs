# Tasks

One markdown file per task; one ADR scaffold per task. Tasks are
named `phase-N[-K]-<slug>.md`, where `K` only appears when a single
PLAN.md phase is split into multiple session-sized tasks.

Source of truth for goals & ordering: [`../PLAN.md`](../PLAN.md).

## Index

| #     | Task                                                               | ADR                                                                | PLAN.md phase |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------- |
| 0     | [Repo health & TS conversion](./phase-0-repo-health.md)            | [adr](./phase-0-repo-health.adr.md)                                | 0             |
| 1     | [Domain model & types](./phase-1-domain-model.md)                  | [adr](./phase-1-domain-model.adr.md)                               | 1             |
| 2     | [Storage layer](./phase-2-storage-layer.md)                        | [adr](./phase-2-storage-layer.adr.md)                              | 2             |
| 3.1   | [Actor host: SWM mailbox](./phase-3-1-actor-host-swm.md)           | [adr](./phase-3-1-actor-host-swm.adr.md)                           | 3a, 3b (SWM)  |
| 3.2   | [Event-sourced actors](./phase-3-2-event-sourcing.md)              | [adr](./phase-3-2-event-sourcing.adr.md)                           | 3a, 3b (ES)   |
| 3.3   | [Reminders & migrations](./phase-3-3-reminders-migrations.md)      | [adr](./phase-3-3-reminders-migrations.adr.md)                     | 3c, 3d, 3e    |
| 4.1   | [Publish & resolve](./phase-4-1-publish-resolve.md)                | [adr](./phase-4-1-publish-resolve.adr.md)                          | 4a, 4b        |
| 4.2   | [Loader & version policy](./phase-4-2-loader-version-policy.md)    | [adr](./phase-4-2-loader-version-policy.adr.md)                    | 4c, 4d        |
| 4.3   | [Client-pinned manifests](./phase-4-3-client-manifest-pin.md)      | [adr](./phase-4-3-client-manifest-pin.adr.md)                      | 4e            |
| 5.1   | [Fastify + REST](./phase-5-1-fastify-rest.md)                      | [adr](./phase-5-1-fastify-rest.adr.md)                             | 5a            |
| 5.2   | [WebSocket / JSON-RPC](./phase-5-2-websocket-jsonrpc.md)           | [adr](./phase-5-2-websocket-jsonrpc.adr.md)                        | 5b            |
| 5.3   | [SSE & BYO auth hook](./phase-5-3-sse-auth.md)                     | [adr](./phase-5-3-sse-auth.adr.md)                                 | 5c, 5d        |
| 6.1   | [actctl codegen](./phase-6-1-codegen.md)                           | [adr](./phase-6-1-codegen.adr.md)                                  | 6d            |
| 6.2   | [@actjs/client SDK](./phase-6-2-sdk-client.md)                     | [adr](./phase-6-2-sdk-client.adr.md)                               | 6a            |
| 6.3   | [React & Svelte bindings](./phase-6-3-sdk-bindings.md)             | [adr](./phase-6-3-sdk-bindings.adr.md)                             | 6b, 6c        |
| 7.1   | [Policy & capabilities](./phase-7-1-policy-capabilities.md)        | [adr](./phase-7-1-policy-capabilities.adr.md)                      | 7a, 7b        |
| 7.2   | [Audit, signing, limits](./phase-7-2-audit-signing-limits.md)      | [adr](./phase-7-2-audit-signing-limits.adr.md)                     | 7c, 7d, 7e    |
| 8.1   | [Observability](./phase-8-1-observability.md)                      | [adr](./phase-8-1-observability.adr.md)                            | 8a            |
| 8.2   | [actctl & test harness](./phase-8-2-actctl-test-harness.md)        | [adr](./phase-8-2-actctl-test-harness.adr.md)                      | 8b, 8c        |
| 9     | [Cluster seams (deferred)](./phase-9-cluster-seams.md)             | [adr](./phase-9-cluster-seams.adr.md)                              | 9             |

## Conventions

- Each task has a **Goal** (1–2 sentences), **Done when** (concrete
  exit criteria), grouped **Checklist** boxes, and a **Risks &
  watch-outs** section.
- An ADR is filed as part of completing the task. The scaffold lists
  the decisions the ADR is *likely* to cover; the author confirms,
  expands, or trims at fill-in time.
- A task that uncovers new design choices not listed in the ADR
  scaffold must add them before merging.
- Tasks are sized for one focused session (a couple of days of work).
  If something turns out larger, split it before completing — don't
  let a task balloon.

## Ordering hints

The dependency graph from PLAN.md:

```
0 → 1 → 2 → 3.1 → 3.2 → 3.3
              ↓
              4.1 → 4.2 → 4.3
                           ↓
                          5.1 → 5.2 → 5.3
                                       ↓
                                      6.1 → 6.2 → 6.3
                                                   ↓
                                                  7.1 → 7.2
                                                         ↓
                                                        8.1 → 8.2
9 runs in parallel with later phases as a review checklist.
```

3.2 (event sourcing) can defer behind 3.3 if SWM-only is enough
to unblock 4.x.
