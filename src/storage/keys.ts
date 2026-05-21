/**
 * Valkey key conventions. Centralizing the strings here keeps refactors
 * mechanical and makes the layout searchable.
 *
 * See PLAN.md § Phase 2b for the canonical table.
 */
import type { ActorId, ClassName, Version } from '../types/ids.js';

export const k = {
  actorHot: (id: ActorId) => `actor:${id as string}:hot`,
  actorOwner: (id: ActorId) => `actor:${id as string}:owner`,
  actorFence: (id: ActorId) => `actor:${id as string}:fence`,
  actorInbox: (id: ActorId) => `actor:${id as string}:inbox`,
  actorMeta: (id: ActorId) => `actor:${id as string}:meta`,

  /**
   * Reminders ZSET key. v1 uses a single global key; v2 cluster will
   * shard by time bucket — see Phase 9 cluster-seam audit. The
   * `ValkeyPgStorageDriver` accepts an override via the `remindersKey`
   * option so a future sharded driver can substitute its own scheme
   * without touching the dispatcher.
   */
  reminders: 'reminders',

  manifestCache: (sha: string) => `manifest:${sha}`,
  manifestLastSeen: (sha: string) => `manifest:${sha}:lastSeen`,
  manifestLocked: 'manifest_locked',

  idempotency: (key: string) => `idem:${key}`,

  classMeta: (name: ClassName) => `class:${name as string}:meta`,
  classVersion: (name: ClassName, version: Version) =>
    `class:${name as string}:v:${version as string}`,

  classBlob: (sha: string) => `blob:${sha}`,
} as const;
