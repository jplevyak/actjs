-- 0001 — initial schema, down
-- Reverses 0001_init.up.sql cleanly enough that an up → down → up cycle on a
-- fresh database is a no-op.

BEGIN;

DROP TABLE IF EXISTS audit;
DROP TABLE IF EXISTS manifest;
DROP TABLE IF EXISTS class_blob;
DROP TABLE IF EXISTS class_version;

-- Drop every partition; CASCADE handles the bootstrap partition and the default.
DROP TABLE IF EXISTS actor_event CASCADE;
DROP TABLE IF EXISTS actor_snapshot;
DROP TABLE IF EXISTS actor;

COMMIT;
