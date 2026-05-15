#!/usr/bin/env bash
#
# Daily Supabase -> S3 backup. See deploy/DB_BACKUP.md for the design.
# Invoked by warehouse-geocoder-backup.service.
#
# Required environment (loaded from /etc/warehouse-geocoder.env by systemd):
#   BACKUP_DATABASE_URL  Supabase connection that supports pg_dump:
#                        either the direct DB host, or the session-mode
#                        pooler on port 5432. NOT the transaction pooler
#                        on port 6543 — that breaks pg_dump.
#   DATABASE_URL         pooled connection used for the CronRunLog insert
#   S3_BUCKET            target bucket
# Optional:
#   S3_PREFIX            defaults to supabase/warehouse-geocoder
#   BACKUP_DIR           defaults to /var/backups/warehouse-geocoder
#   BACKUP_SCHEMAS       comma-separated, defaults to "public"

set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL not set}"
: "${DATABASE_URL:?DATABASE_URL not set}"
: "${S3_BUCKET:?S3_BUCKET not set}"
S3_PREFIX="${S3_PREFIX:-supabase/warehouse-geocoder}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/warehouse-geocoder}"
BACKUP_SCHEMAS="${BACKUP_SCHEMAS:-public}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

START_EPOCH_MS=$(date -u +%s%3N)
START_EPOCH_S=$((START_EPOCH_MS / 1000))
RAN_AT=$(date -u -d "@${START_EPOCH_S}" +"%Y-%m-%d %H:%M:%S")
TS=$(date -u -d "@${START_EPOCH_S}" +"%Y%m%dT%H%M%SZ")
DATE_PATH=$(date -u -d "@${START_EPOCH_S}" +"%Y/%m/%d")

# Start marker. The OnFailure unit reads this to recover the start time so a
# crashed run still produces a CronRunLog row with an accurate duration.
# Cleared only after a successful CronRunLog insert.
MARKER="$BACKUP_DIR/.last_start"
printf '%s\n' "$RAN_AT" > "$MARKER"

DUMP_FILE="$BACKUP_DIR/dump-${TS}.dump"
S3_KEY="${S3_PREFIX}/${DATE_PATH}/dump-${TS}.dump"

# Always clean up the local dump on exit. The marker is intentionally NOT
# cleaned here — its presence is the failure signal.
trap 'rm -f "$DUMP_FILE"' EXIT

echo "[backup] start ${TS}"
echo "[backup] schemas=${BACKUP_SCHEMAS}"
echo "[backup] target s3://${S3_BUCKET}/${S3_KEY}"

PG_SERVER_VERSION=$(
  PGOPTIONS='-c statement_timeout=10000' \
  psql "$BACKUP_DATABASE_URL" -tAX -c "show server_version" \
    | tr -d '[:space:]'
)
echo "[backup] server_version=${PG_SERVER_VERSION}"

# Build --schema flags from comma-separated BACKUP_SCHEMAS.
SCHEMA_ARGS=()
IFS=',' read -ra _schemas <<< "$BACKUP_SCHEMAS"
for s in "${_schemas[@]}"; do
  s="${s// /}"
  [[ -n "$s" ]] && SCHEMA_ARGS+=( "--schema=$s" )
done

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --verbose \
  "${SCHEMA_ARGS[@]}" \
  --file="$DUMP_FILE" \
  "$BACKUP_DATABASE_URL"

BYTES=$(stat -c '%s' "$DUMP_FILE")
echo "[backup] dump complete bytes=${BYTES}"

# Bucket has default SSE-S3 encryption, so no --sse flag needed.
aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${S3_KEY}" --only-show-errors
echo "[backup] uploaded"

END_EPOCH_MS=$(date -u +%s%3N)
DURATION_MS=$((END_EPOCH_MS - START_EPOCH_MS))

# Build schemas JSON array literal for jsonb_build_array() args. We pass it
# as a single quoted JSON string and parse on the SQL side.
SCHEMAS_JSON=$(printf '%s' "$BACKUP_SCHEMAS" | awk -F',' '{
  printf "["
  for (i = 1; i <= NF; i++) {
    gsub(/^ +| +$/, "", $i)
    printf "%s\"%s\"", (i>1?",":""), $i
  }
  printf "]"
}')

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v ran_at="$RAN_AT" \
  -v duration_ms="$DURATION_MS" \
  -v s3_bucket="$S3_BUCKET" \
  -v s3_key="$S3_KEY" \
  -v bytes="$BYTES" \
  -v pg_server_version="$PG_SERVER_VERSION" \
  -v schemas_json="$SCHEMAS_JSON" \
  <<'SQL'
INSERT INTO "CronRunLog" ("jobName","ranAt","status","durationMs","metadata","notes")
VALUES (
  'backup-db',
  :'ran_at'::timestamp,
  'success',
  :duration_ms,
  jsonb_build_object(
    's3Bucket',        :'s3_bucket',
    's3Key',           :'s3_key',
    'bytes',           :bytes::bigint,
    'schemas',         (:'schemas_json')::jsonb,
    'pgServerVersion', :'pg_server_version'
  ),
  NULL
);
SQL

rm -f "$MARKER"
echo "[backup] done duration_ms=${DURATION_MS}"
