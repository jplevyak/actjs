#!/usr/bin/env bash
#
# Minimum-viable backup script for an actjs deployment.
#
# Outputs:
#   * pg_dump custom-format archive of actjs (point-in-time-recoverable)
#   * Valkey RDB via BGSAVE then a cp of the resulting dump.rdb
#
# Defaults are wired for the docker-compose stack. Override via env.
# An UPLOAD_HOOK env var, if set, is invoked per artifact:
#   UPLOAD_HOOK="aws s3 cp" or "rclone copy --to=remote:bucket".
#
# Operators integrate this with their own scheduling (cron, k8s
# CronJob, etc). The script is intentionally small.

set -euo pipefail

OUTDIR="${OUTDIR:-./backups/$(date -u +%Y%m%dT%H%M%SZ)}"
POSTGRES_DSN="${POSTGRES_DSN:-postgres://actjs:actjs@localhost:5432/actjs}"
VALKEY_HOST="${VALKEY_HOST:-localhost}"
VALKEY_PORT="${VALKEY_PORT:-6379}"
VALKEY_DATA_DIR="${VALKEY_DATA_DIR:-/data}"
UPLOAD_HOOK="${UPLOAD_HOOK:-}"

mkdir -p "$OUTDIR"
echo "writing artifacts to $OUTDIR"

echo "→ pg_dump"
pg_dump --format=custom --no-owner --dbname="$POSTGRES_DSN" \
  --file="$OUTDIR/postgres.dump"

echo "→ valkey BGSAVE"
valkey-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" BGSAVE
# Poll until LASTSAVE bumps. 60s budget.
prev=$(valkey-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" LASTSAVE)
for _ in $(seq 1 60); do
  cur=$(valkey-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" LASTSAVE)
  if [[ "$cur" != "$prev" ]]; then break; fi
  sleep 1
done
cp "$VALKEY_DATA_DIR/dump.rdb" "$OUTDIR/valkey.rdb"

if [[ -n "$UPLOAD_HOOK" ]]; then
  echo "→ uploading via $UPLOAD_HOOK"
  for f in "$OUTDIR"/*; do
    $UPLOAD_HOOK "$f"
  done
fi

echo "done."
