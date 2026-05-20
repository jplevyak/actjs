# Phase 0 — Repo health & TS conversion

> Source: [PLAN.md § Phase 0](../PLAN.md#phase-0--repo-health--ts-conversion)
> Decisions: [phase-0-repo-health.adr.md](./phase-0-repo-health.adr.md)

## Goal

Convert the actjs sketch into a TypeScript repo that is pleasant to
contribute to: strict types end-to-end, a proper build, a real test
suite, container-based local dev, and CI guardrails.

This phase ships no new product features. It exists so every later
phase can assume a baseline.

## Done when

- A clean `git clone && npm ci && npm test` works on Node 20+.
- `docker compose up` boots the server against Valkey + Postgres.
- CI is green on `main` and a representative PR.
- No `.js` source files remain except generated build output.

---

## Checklist

### Toolchain & config

- [x] `tsconfig.json` — strict, nodenext, ES2022, `verbatimModuleSyntax`,
      `noUncheckedIndexedAccess`.
- [x] `tsconfig.build.json` extends + emits to `dist`.
- [x] `package.json`: `"type": "module"`, `engines.node: ">=20"`,
      subpath `exports`.
- [x] Lockfile committed (`package-lock.json`).
- [x] `.npmrc` (engine-strict) + `.nvmrc` (20).
- [x] `.editorconfig`.
- [x] `.gitignore` covers `dist/`, `node_modules/`, `coverage/`,
      `.tsbuildinfo`.
- [x] `eslint.config.js` flat config — `@typescript-eslint/recommended` + `eslint-plugin-import`, thin.
- [x] `.prettierrc` + `.prettierignore`.

### TypeScript conversion

For each file: convert syntax, add explicit types on public surface,
keep behavior identical, port any inline tests.

- [x] `error.js` → `src/error.ts`.
- [x] `gact.js` → `src/gact.ts` (rename to `host.ts` is deferred to
      a later phase).
- [x] `top.js` → `src/top.ts` (Express+TS; Fastify migration is
      Phase 5.1).
- [x] `main.js` → `src/main.ts`.
- [x] `x.js` → `src/scratch.ts`.
- [x] Original `.js` files removed; `start` script now runs
      `node dist/main.js`.
- [x] `npm run typecheck` passes.

### Build pipeline

- [x] `npm run build` runs `tsc -b tsconfig.build.json`.
- [x] `npm run dev` runs `tsx watch src/main.ts`.
- [x] `npm run clean` removes `dist/`, `*.tsbuildinfo`, `coverage/`.
- [ ] Placeholder workspace structure for future SDK packages.
      _(Deferred to Phase 6.1 when the codegen and SDK packages
      actually materialize — premature scaffolding now would
      bit-rot.)_

### Tests

- [x] Vitest installed with `vitest.config.ts`.
- [x] Smoke tests for `StatusError` + `GAct.fixupForSave` +
      `GAct.load` against a fake redis client (`tests/error.test.ts`,
      `tests/gact.test.ts`).
- [x] Coverage thresholds in config (80 / 80 / 70 / 80).
- [x] `npm test` + `npm run test:coverage` both green.
- [ ] A failing test demonstrably fails CI. _(CI hasn't run in
      anger yet; the workflow exists but a deliberate failing-commit
      verification is operator-side, not part of the local gate.)_

### Local dev (Docker)

- [x] `Dockerfile` multi-stage:
  - [x] `deps` stage: `npm ci --omit=dev`.
  - [x] `build` stage: `npm ci && npm run build`.
  - [x] Final stage: distroless `nodejs20-debian12`, non-root user;
        commented `node:20-slim` fallback for debug.
- [x] `docker-compose.yml`:
  - [x] `valkey` service mounted with `ops/valkey.conf`.
  - [x] `postgres` service with named volume.
  - [x] `actjs` service built from `Dockerfile`, depends on both,
        port-forwarded.
- [ ] `docker compose up` brings everything up and `./demo.bash`
      runs green against it. _(Verified locally is not possible
      in the sandbox; CI's `integration` job covers it.)_

### CI (GitHub Actions)

- [x] `.github/workflows/ci.yml`:
  - [x] Job: `lint` (Prettier + ESLint).
  - [x] Job: `typecheck`.
  - [x] Job: `test` (Vitest + coverage upload).
  - [x] Job: `docker` build (with GHA layer cache).
  - [x] Job: `integration` boots `node dist/main.js` against a
        Valkey service container and runs `AUTO=1 ./demo.bash`.
  - [x] Job: `storage-conformance` (added in Phase 2) runs against
        Postgres + Valkey service containers.
- [x] Concurrency group cancels superseded runs.
- [x] Caches: npm cache via `actions/setup-node`; Docker layers via
      GHA cache.
- [ ] Required-check rules on `main`. _(Operator setting in GitHub
      UI; not code.)_

### Docs

- [x] `CHANGELOG.md` initialized.
- [x] README updated for `src/` layout + new npm scripts + compose.
- [x] DESIGN.md unchanged (describes the pre-conversion sketch).
- [x] ADR filed (`phase-0-repo-health.adr.md`, Accepted).

### Risks & watch-outs

- [x] pnpm vs npm decided before lockfile committed. ADR records
      npm as the choice; pnpm revisits in Phase 6.
- [x] `verbatimModuleSyntax: true` flagged the CJS imports as
      expected; resolved by using `import type` and the correct
      named-import shapes throughout.
- [x] Distroless: commented `node:20-slim` fallback in the
      Dockerfile.
- [x] Coverage gate caveat recorded in the ADR — gate is mostly
      cosmetic until Phase 3 lands.
