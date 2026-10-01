#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/node --max-old-space-size=128 /usr/local/lib/warehouse-enricher-backup/run.mjs --failure
