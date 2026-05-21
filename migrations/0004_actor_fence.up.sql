-- 0004 — actor fence token
-- Phase 9 cluster-seam audit (tasks/phase-9-cluster-seams.md).
--
-- v1 single-node never bumps this column; the storage driver checks
-- the expected fence on every `appendEvents` / `saveSnapshot` so v2
-- cluster placement can land without rewriting the runtime. See
-- StaleFenceTokenError in src/storage/driver.ts.

BEGIN;

ALTER TABLE actor
  ADD COLUMN IF NOT EXISTS fence bigint NOT NULL DEFAULT 0;

COMMIT;
