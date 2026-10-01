#!/usr/bin/env bash
# Installed outside the app release so application rollback keeps queue backups.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/warehouse-geocoder}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
exec flock -n "$BACKUP_DIR/.backup.lock" /usr/bin/node --max-old-space-size=128 /usr/local/lib/warehouse-enricher-backup/run.mjs
