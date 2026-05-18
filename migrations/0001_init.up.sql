-- 0001 — initial schema
-- PLAN.md § Phase 2a. Postgres is the source of truth for actors,
-- snapshots, events, class versions/blobs, manifests, and audit.
-- Valkey caches hot reads + serves liveness queues (see Phase 2b).

BEGIN;

-- ---------------------------------------------------------------- actor
CREATE TABLE IF NOT EXISTS actor (
  id              uuid        PRIMARY KEY,
  class           text        NOT NULL,
  version         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz,
  tombstoned_at   timestamptz,
  tags            jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS actor_tags_gin
  ON actor USING gin (tags jsonb_path_ops);

CREATE INDEX IF NOT EXISTS actor_class_idx
  ON actor (class) WHERE tombstoned_at IS NULL;

-- ---------------------------------------------------------------- actor_snapshot
-- seq == 0 for SWM actors (no event log); seq > 0 for ES.
-- A sentinel row at seq = -1 holds the pre-migrate state for
-- the retention window (3.3).
CREATE TABLE IF NOT EXISTS actor_snapshot (
  actor_id        uuid        NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
  seq             bigint      NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  class_version   text        NOT NULL,
  bytes           bytea       NOT NULL,
  PRIMARY KEY (actor_id, seq)
);

-- ---------------------------------------------------------------- actor_event (partitioned)
CREATE TABLE IF NOT EXISTS actor_event (
  actor_id        uuid        NOT NULL,
  seq             bigint      NOT NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  class_version   text        NOT NULL,
  type            text        NOT NULL,
  payload         jsonb       NOT NULL,
  causation_id    uuid,
  PRIMARY KEY (actor_id, seq, ts)
) PARTITION BY RANGE (ts);

-- A default partition catches everything until the partition-creator
-- (Phase 8 cron) takes over with explicit monthly partitions.
CREATE TABLE IF NOT EXISTS actor_event_default PARTITION OF actor_event DEFAULT;

-- A bootstrap partition for the current month so the partition layout
-- is exercised from day one.
DO $$
DECLARE
  start_ts timestamptz := date_trunc('month', now());
  end_ts   timestamptz := date_trunc('month', now()) + interval '1 month';
  part     text        := 'actor_event_' || to_char(start_ts, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = part
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF actor_event FOR VALUES FROM (%L) TO (%L)',
      part, start_ts, end_ts
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS actor_event_default_actor_seq
  ON actor_event_default (actor_id, seq);

-- ---------------------------------------------------------------- class_version
CREATE TABLE IF NOT EXISTS class_version (
  name            text        NOT NULL,
  version         text        NOT NULL,
  source_sha256   bytea       NOT NULL,
  deps            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  engines         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  published_at    timestamptz NOT NULL DEFAULT now(),
  deprecated_at   timestamptz,
  grace_until     timestamptz,
  signed_by       text,
  signature       bytea,
  floating        boolean     NOT NULL DEFAULT false,
  event_sourced   boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (name, version)
);

CREATE INDEX IF NOT EXISTS class_version_active
  ON class_version (name) WHERE deprecated_at IS NULL;

-- ---------------------------------------------------------------- class_blob
CREATE TABLE IF NOT EXISTS class_blob (
  sha256          bytea       PRIMARY KEY,
  bytes           bytea       NOT NULL
);

-- ---------------------------------------------------------------- manifest
CREATE TABLE IF NOT EXISTS manifest (
  sha256          bytea       PRIMARY KEY,
  resolved        jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit (
  id              uuid        PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  principal       text        NOT NULL,
  action          text        NOT NULL,
  target          text        NOT NULL,
  meta            jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit (ts);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit (action);

COMMIT;
