import { sweepImages } from './imageSweeps.mjs';
import { sweepProximity, proximityCandidates } from './proximitySweep.mjs';

export function createEnrichmentSweep({ repository, proximity, services, runLog, configured }) {
  const specs = [
    { name: 'labels', stage: 'label', service: 'image-label', limit: 50, duration: 160000 },
    { name: 'documents', stage: 'document', service: 'document-kind', limit: 50, duration: 60000 },
    { name: 'websiteImages', stage: 'website', service: 'website-approval', limit: 12, duration: 160000 },
  ];
  async function preview() {
    const stages = {};
    for (const spec of specs) stages[spec.name] = { backlog: await repository.bounded('backlog', spec.stage), limit: spec.limit };
    const { rows, skippedCategories } = await proximityCandidates(proximity);
    stages.proximity = { eligibleSample: rows.length, limit: 5, skippedCategories };
    return { status: 'DRY_RUN', configured: configured(), stages };
  }

  async function work({ signal }) {
    signal.throwIfAborted();
    const reconciliation = await repository.bounded('reconcile');
    await repository.bounded('expireClaims');
    const stages = {};
    async function runStage(name, duration, action, jobName) {
      if (signal.aborted) { stages[name] = { status: 'PARTIAL', reason: 'interrupted' }; return; }
      const log = jobName ? await runLog.tryStart(jobName, 15 * 60000, { executor: 'warehouse-enricher' }) : null;
      if (jobName && !log) { stages[name] = { status: 'SKIPPED', reason: 'already_running' }; return; }
      const controller = new AbortController(), started = Date.now();
      const timer = setTimeout(() => controller.abort(), duration);
      timer.unref?.();
      const stageSignal = AbortSignal.any([signal, controller.signal]);
      try { stages[name] = await action(stageSignal); }
      catch (error) { stages[name] = { status: stageSignal.aborted ? 'PARTIAL' : 'FAILED',
        reason: stageSignal.aborted ? 'interrupted' : error.statusCode === 503 ? 'configuration_missing' : 'stage_failed' }; }
      finally { clearTimeout(timer); }
      if (log) await runLog.finish(log.id, stages[name].status, Date.now() - started, stages[name]);
    }
    // The legacy label lock also covers the independently callable subtype action.
    await runStage('images', 230000, async labelSignal => {
      for (const spec of specs.slice(0, 2)) {
        await runStage(spec.name, spec.duration, stageSignal => sweepImages({ repository, services, ...spec,
          signal: AbortSignal.any([labelSignal, stageSignal]) }));
      }
      return { status: ['labels','documents'].some(name => stages[name].status !== 'SUCCESS') ? 'PARTIAL' : 'SUCCESS' };
    }, 'sweep_warehouse_image_labels');
    const website = specs[2];
    await runStage(website.name, website.duration,
      stageSignal => sweepImages({ repository, services, ...website, signal: stageSignal }), 'sweep_warehouse_website_images');
    await runStage('proximity', 160000, stageSignal => sweepProximity({ model: proximity, services, runLog, signal: stageSignal }));
    const values = Object.values(stages);
    return { status: values.every(stage => stage.status === 'FAILED') ? 'FAILED'
      : values.some(stage => stage.status !== 'SUCCESS') ? 'PARTIAL' : 'SUCCESS', reconciliation, stages };
  }
  return { preview, work };
}
