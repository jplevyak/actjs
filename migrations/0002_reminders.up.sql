-- 0002 — reminder PG mirror.
-- See tasks/phase-3-3-reminders-migrations.adr.md for the durability rationale.

BEGIN;

CREATE TABLE IF NOT EXISTS reminder (
  id            uuid        PRIMARY KEY,
  when_ms       bigint      NOT NULL,
  actor_id      uuid        NOT NULL,
  class         text        NOT NULL,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

-- Pending queue: the dispatcher tick scans this index.
CREATE INDEX IF NOT EXISTS reminder_pending_when_idx
  ON reminder (when_ms) WHERE delivered_at IS NULL;

COMMIT;
