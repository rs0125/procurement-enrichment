import { positiveId } from '../../lib/runtime/executor.mjs';

export function imageStage(stage, { repository, processImage, invalidate = async () => {}, configured = () => true }) {
  return async ({ imageId, dryRun = false, signal }) => {
    positiveId(imageId);
    const source = await repository.getActive(imageId);
    if (!source) return { status: 'SKIPPED', reason: 'image_not_referenced', imageId };
    if (dryRun) return { status: 'DRY_RUN', imageId, stage, currentStatus: source[`${stage}Status`], configured: configured() };
    if (source[`${stage}Status`] === 'READY' || (stage === 'label' && source.classification)
      || (stage === 'document' && source.documentKind)) {
      if (stage === 'webp') await repository.projectLegacy(imageId);
      return { status: 'SKIPPED', reason: 'already_ready', imageId };
    }
    if (stage === 'document' && source.classification !== 'DOCUMENT') {
      return { status: source.classification ? 'SKIPPED' : 'DEFERRED', reason: source.classification ? 'not_a_document' : 'label_required', imageId };
    }
    if (!configured()) { const error = new Error('Service configuration missing'); error.statusCode = 503; throw error; }
    signal?.throwIfAborted();
    const [claim] = await repository.claim(stage, { imageId, limit: 1 });
    if (!claim) {
      if (stage === 'webp' && source.webpStatus === 'READY') await repository.projectLegacy(imageId);
      return { status: 'SKIPPED', reason: 'ready_ineligible_or_claimed', imageId };
    }
    const row = { ...source, ...claim };
    let result, started = false;
    try {
      signal?.throwIfAborted();
      started = true;
      result = await processImage(row, { signal });
      signal?.throwIfAborted();
    } catch (error) {
      const deferred = ((!started || stage === 'webp') && signal?.aborted) || error.code === 'memory_pressure';
      await repository.fail(stage, row, deferred ? '' : 'Image enrichment failed', { deferred, unsupported: Boolean(error.unsupported) });
      return { status: deferred || signal?.aborted ? 'DEFERRED' : error.unsupported ? 'UNSUPPORTED' : 'FAILED', imageId, reason: deferred || signal?.aborted ? 'interrupted' : 'processing_failed' };
    }
    // A failed publication retains its lease. Retrying after expiry can repeat
    // the provider call; the token fences publication, not provider billing.
    const saved = await repository.complete(stage, row, result);
    if (saved) {
      await invalidate();
      if (stage === 'webp') await repository.projectLegacy(imageId);
    }
    return { status: saved ? 'READY' : 'STALE', imageId, ...(result.usage ? { usage: result.usage } : {}) };
  };
}
