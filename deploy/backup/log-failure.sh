#!/usr/bin/env bash
#
# Failure logger for warehouse-geocoder-backup. Invoked by
# warehouse-geocoder-backup-failure.service via OnFailure=.
#
# Reads the start marker left by backup.sh to recover the run's start time,
# then writes a failure row to CronRunLog. If the marker is missing
# (unexpected) we still write a row, using "now" as ranAt.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL not set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/warehouse-geocoder}"
MARKER="$BACKUP_DIR/.last_start"

END_EPOCH_MS=$(date -u +%s%3N)

if [[ -r "$MARKER" ]]; then
  RAN_AT=$(cat "$MARKER")
  START_EPOCH_MS=$(date -u -d "$RAN_AT UTC" +%s%3N)
  DURATION_MS=$((END_EPOCH_MS - START_EPOCH_MS))
  rm -f "$MARKER"
else
  RAN_AT=$(date -u -d "@$((END_EPOCH_MS / 1000))" +"%Y-%m-%d %H:%M:%S")
  DURATION_MS=0
fi

NOTES="backup unit failed; see journalctl -u warehouse-geocoder-backup"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v ran_at="$RAN_AT" \
  -v duration_ms="$DURATION_MS" \
  -v notes="$NOTES" \
  <<'SQL'
INSERT INTO "CronRunLog" ("jobName","ranAt","status","durationMs","metadata","notes")
VALUES (
  'backup-db',
  :'ran_at'::timestamp,
  'failure',
  :duration_ms,
  NULL,
  :'notes'
);
SQL
