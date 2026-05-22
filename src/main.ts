/**
 * Public umbrella entry for `@jplevyak/actjs`.
 *
 * Side-effect-free re-export barrel. Importing the package never
 * starts a server, never opens a connection, never schedules a
 * timer. The HTTP server bootstrap lives in `src/cli/start.ts`
 * and ships as the `actjs-server` bin.
 *
 * For finer-grained imports, prefer the subpath exports (see
 * `package.json` `exports`):
 *
 *   - `@jplevyak/actjs/runtime`  — `Runtime`, `ActorHost`
 *   - `@jplevyak/actjs/storage`  — drivers
 *   - `@jplevyak/actjs/server`   — `buildApp` + Fastify wiring
 *   - `@jplevyak/actjs/client`   — WebSocket client SDK
 *   - `@jplevyak/actjs/test`     — `TestRuntime` + assertions
 *   - `@jplevyak/actjs/types`    — branded IDs, `Envelope`, `Principal`
 *   - `@jplevyak/actjs/policy`   — `policy()`, capabilities, blocklist
 *   - `@jplevyak/actjs/codegen`  — programmatic codegen API
 *   - `@jplevyak/actjs/bindings` — framework-agnostic store binding
 *   - `@jplevyak/actjs/bindings/react`  — React hooks
 *   - `@jplevyak/actjs/bindings/svelte` — Svelte adapter
 *   - `@jplevyak/actjs/wire`     — JSON-RPC envelope types
 */
export { Actor } from './actor.js';
export { EventSourced } from './event-sourced.js';
export { Replica } from './replica.js';
export { getHandlers, handler, type HandlerFn, type HandlerRegistry } from './handler.js';

export type { ActorId, ClassName, Version } from './types/ids.js';
export type { ActorRef, Envelope } from './types/envelope.js';
export type { Principal } from './types/principal.js';
