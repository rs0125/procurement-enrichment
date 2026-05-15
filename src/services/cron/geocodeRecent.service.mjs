import { prisma } from "../../config/prisma.mjs";
import { warmUpSession } from "../../lib/googleMaps/session.mjs";
import { extractCoordinatesFromUrl } from "../../lib/googleMaps/extractor.mjs";
import {
  findPendingRecent,
  recordSuccess,
  recordFailure,
} from "../../models/geocode/attemptRepo.mjs";
import { upsertCoords } from "../../models/geocode/warehouseDataRepo.mjs";
import { insertRunLog } from "../../models/cron/runLogRepo.mjs";

const JOB_NAME = "geocode-recent";
const SCOPE = "recent-7d";
const DELAY_BETWEEN_REQUESTS_MS = 2000;
const BATCH_SIZE = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runGeocodeRecent() {
  const startedAt = Date.now();

  let warmedOk = false;
  try {
    await warmUpSession();
    warmedOk = true;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const log = await insertRunLog({
      jobName: JOB_NAME,
      status: "partial",
      durationMs,
      metadata: {
        scope: SCOPE,
        candidates: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
      },
      notes: `warmup_failed: ${err?.message ?? String(err)}`,
    });
    return {
      runId: Number(log.id),
      jobName: JOB_NAME,
      scope: SCOPE,
      candidates: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      durationMs,
    };
  }

  const pending = await findPendingRecent();
  const candidates = pending.length;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let batchCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const w = pending[i];
    batchCount++;

    if (batchCount > BATCH_SIZE) {
      try {
        await warmUpSession();
      } catch {
        // best-effort re-warm; continue on failure
      }
      batchCount = 1;
    }

    let result;
    try {
      result = await extractCoordinatesFromUrl(w.googleLocation);
    } catch (err) {
      result = {
        lat: null,
        lng: null,
        via: "error_thrown",
        error: err?.message ?? String(err),
      };
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (result.lat != null && result.lng != null) {
          await upsertCoords(tx, {
            warehouseId: w.id,
            lat: result.lat,
            lng: result.lng,
          });
          await recordSuccess(tx, {
            warehouseId: w.id,
            via: result.via,
          });
        } else {
          await recordFailure(tx, {
            warehouseId: w.id,
            via: result.via,
            error: result.error ?? null,
          });
        }
      });

      processed++;
      if (result.lat != null) succeeded++;
      else failed++;
    } catch (err) {
      processed++;
      failed++;
      console.error(`[geocode-recent] db write failed for warehouse ${w.id}`, err);
    }

    if (i < pending.length - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  const durationMs = Date.now() - startedAt;
  const status = failed === 0 ? "ok" : failed === candidates && candidates > 0 ? "error" : "partial";

  const log = await insertRunLog({
    jobName: JOB_NAME,
    status,
    durationMs,
    metadata: { scope: SCOPE, candidates, processed, succeeded, failed },
    notes: warmedOk ? null : "warmup_recovered",
  });

  return {
    runId: Number(log.id),
    jobName: JOB_NAME,
    scope: SCOPE,
    candidates,
    processed,
    succeeded,
    failed,
    durationMs,
  };
}
