-- 0003 — signing keys
-- PLAN.md § Phase 7d (publish-time code signing).
--
-- Stores the public key registry used to verify class-publish
-- signatures. The registry is consulted by `publishClass` when
-- `requireSignedClasses` is true or a `signature` is supplied.
--
-- Memory-backed test drivers use `MemorySigningKeyRegistry`; a
-- PG-backed adapter lands in 7.2b.

BEGIN;

CREATE TABLE IF NOT EXISTS signing_key (
  kid             text        PRIMARY KEY,
  algorithm       text        NOT NULL,
  public_key_pem  text        NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE INDEX IF NOT EXISTS signing_key_active_idx
  ON signing_key (kid) WHERE revoked_at IS NULL;

COMMIT;
