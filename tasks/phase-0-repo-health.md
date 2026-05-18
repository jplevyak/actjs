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

- [ ] `tsconfig.json` — `"strict": true`, `"module": "nodenext"`,
      `"moduleResolution": "nodenext"`, `"target": "es2022"`,
      `"verbatimModuleSyntax": true`, `"noUncheckedIndexedAccess": true`.
- [ ] `tsconfig.build.json` extends the above, sets `outDir: dist`,
      excludes tests.
- [ ] Update `package.json`: `"type": "module"` confirmed,
      `"engines": { "node": ">=20" }`, `"main"`/`"exports"` point at
      `dist/`.
- [ ] Lockfile committed (`package-lock.json` or `pnpm-lock.yaml`).
      Decide pnpm vs npm in the ADR before locking.
- [ ] `.npmrc` / `.nvmrc` pinning Node version.
- [ ] `.editorconfig`.
- [ ] `.gitignore` covers `dist/`, `node_modules/`, `coverage/`,
      `.turbo/`, `*.tsbuildinfo`.
- [ ] `eslint.config.js` (flat config), `@typescript-eslint`,
      `eslint-plugin-import`. Thin: don't fight Prettier.
- [ ] `.prettierrc` + `.prettierignore`.

### TypeScript conversion

For each file: convert syntax, add explicit types on public surface,
keep behavior identical, port any inline tests.

- [ ] `error.js` → `src/error.ts`. `StatusError` already a class;
      add typed `status` field, default exports.
- [ ] `gact.js` → `src/gact.ts`. Annotate `Actor`, `Aggregate`,
      `Replica`, `GAct`. (The actual rename to `actjs`/`host.ts`
      lands in later phases — Phase 0 only ports.)
- [ ] `top.js` → `src/top.ts`. Type Fastify routes loosely;
      Fastify migration is Phase 5, this is Express+TS for now.
- [ ] `main.js` → `src/main.ts`.
- [ ] `x.js` → `src/scratch.ts` (rename: `x` is meaningless).
- [ ] Delete the original `.js` files; update `package.json`
      `"scripts.start"` to `node dist/main.js`.
- [ ] `npm run typecheck` passes (`tsc --noEmit`).

### Build pipeline

- [ ] `npm run build` runs `tsc -b` (incremental).
- [ ] `npm run dev` uses `tsx` (or `node --watch` + `tsc -w`) for
      hot reload during local development.
- [ ] `npm run clean` removes `dist/` and `*.tsbuildinfo`.
- [ ] Placeholder workspace structure for future SDK packages
      (`packages/client`, `packages/react`, `packages/svelte`)
      using `tsup` — not implemented, but the build script
      tolerates their absence.

### Tests

- [ ] Vitest installed, `vitest.config.ts` configured for ESM +
      TypeScript paths.
- [ ] `src/*.test.ts` smoke tests covering: `StatusError` shape,
      `GAct.fixupForSave` round-trip, `GAct.load` against a fake
      redis client.
- [ ] Coverage reporter set to `v8`, thresholds in config:
      `lines: 80, functions: 80, branches: 70, statements: 80`.
- [ ] `npm test` and `npm run test:coverage` both green.
- [ ] A failing test demonstrably fails CI (verify with one
      throwaway commit).

### Local dev (Docker)

- [ ] `Dockerfile` — multi-stage:
  - [ ] `deps` stage: `npm ci --omit=dev`.
  - [ ] `build` stage: `npm ci && npm run build`.
  - [ ] Final stage: `gcr.io/distroless/nodejs20-debian12` with
        only `dist/`, `node_modules/` (prod), and a non-root user.
- [ ] `docker-compose.yml`:
  - [ ] `valkey` service on the standard port.
  - [ ] `postgres` service with a named volume; init SQL is empty
        for now (schema lands in Phase 2).
  - [ ] `actjs` service built from `Dockerfile`, depends on both,
        port-forwarded for the demo script.
- [ ] `docker compose up` brings everything up and `./demo.bash`
      runs green against the composed stack.

### CI (GitHub Actions)

- [ ] `.github/workflows/ci.yml`:
  - [ ] Job: `lint` — ESLint + Prettier check.
  - [ ] Job: `typecheck` — `tsc --noEmit`.
  - [ ] Job: `test` — Vitest with coverage upload.
  - [ ] Job: `docker` — `docker build` on every PR; push only on
        tags or `main`.
  - [ ] Job: `integration` — `docker compose up -d`, run
        `./demo.bash AUTO=1` against it, tear down.
- [ ] Concurrency group cancels superseded runs.
- [ ] Caches: npm cache, `tsbuildinfo`, Docker layers.
- [ ] Required-check rules on `main` branch (config in repo
      `.github/branch-protection.yml` if using a tool, otherwise
      documented).

### Docs

- [ ] `CHANGELOG.md` initialized with Keep-A-Changelog header and a
      `[Unreleased]` section.
- [ ] README updated to point at the new `npm` scripts and the
      compose dev flow.
- [ ] DESIGN.md unchanged (it describes the current sketch; that's
      fine post-conversion since shapes are preserved).
- [ ] ADR for this phase filed (see
      [phase-0-repo-health.adr.md](./phase-0-repo-health.adr.md)).

### Risks & watch-outs

- [ ] Decide pnpm vs npm **before** committing the lockfile. Switching
      later means a CI redesign.
- [ ] `verbatimModuleSyntax: true` will flag every legacy
      `import x from 'y'` of CJS deps. Either flip the flag or rewrite
      to `import * as x` consistently — do not mix.
- [ ] Distroless images can't shell-debug; verify a known-good
      Node base image fallback exists in the Dockerfile (commented
      target) before claiming this complete.
- [ ] Coverage gate is meaningful only on real engine code. The
      current sketch barely has 200 lines — coverage will look high
      trivially. Don't let it create false confidence; flag this in
      the ADR.
