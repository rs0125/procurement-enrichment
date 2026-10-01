import categories from '../../lib/proximity/proximityCategories.cjs';
import ProximityRepository from '../../models/proximity/repository.mjs';
import { invoke } from './imageSweeps.mjs';

const expected = ProximityRepository.expectedRegionsFor(categories.CATEGORIES.map(c => c.key), 120, { hospital: 30 });

export async function proximityCandidates(model, limit = 5) {
  const coverage = await model.bounded('coverage', expected);
  const skippedCategories = coverage.filter(c => !c.complete).map(c => c.category);
  const eligible = categories.CATEGORIES.filter(c => !skippedCategories.includes(c.key));
  return { rows: await model.bounded('findPending', eligible, limit), skippedCategories };
}

export async function sweepProximity({ model, services, runLog, signal, limit = 5 }) {
  const { rows, skippedCategories } = await proximityCandidates(model, limit);
  const result = { status: 'SUCCESS', processed: 0, ready: 0, failed: 0, deferred: 0, skippedCategories };
  for (const warehouse of rows) {
    if (signal.aborted) { result.deferred += rows.length - result.processed; break; }
    if(services.deliveryMode==='queue') {
      const item=await invoke(services,'proximity',{warehouseId:warehouse.id},signal);
      result.processed++;result.queued=(result.queued??0)+(item.status==='QUEUED'?1:0);continue;
    }
    const jobName = `warehouse_proximity:${warehouse.id}`;
    const prior = await runLog.recent(jobName);
    const previousAttempts = prior?.status === 'FAILED' && prior.metadata?.lat === warehouse.lat && prior.metadata?.lng === warehouse.lng
      ? Number(prior.metadata.attempts) || 0 : 0;
    const metadata = { lat: warehouse.lat, lng: warehouse.lng, attempts: previousAttempts + 1 };
    const run = await runLog.tryStart(jobName, 15 * 60000, metadata);
    if (!run) { result.deferred++; continue; }
    const started = Date.now();
    result.processed++;
    try {
      const item = await invoke(services, 'proximity', { warehouseId: warehouse.id }, signal);
      if (['FAILED','DEFERRED','STALE'].includes(item.status)) throw new Error('Proximity incomplete');
      if (item.status === 'READY' || item.status === 'PARTIAL') result.ready++;
      await runLog.finish(run.id, 'SUCCESS', Date.now() - started, { ...metadata, rows: item.rows ?? 0 });
    } catch {
      result.failed++;
      const minutes = Math.min(360, 15 * 2 ** Math.min(previousAttempts, 5));
      await runLog.finish(run.id, 'FAILED', Date.now() - started,
        { ...metadata, retryAt: new Date(Date.now() + minutes * 60000).toISOString() });
      result.deferred += rows.length - result.processed;
      break;
    }
  }
  result.status = result.failed ? result.ready ? 'PARTIAL' : 'FAILED'
    : result.deferred || skippedCategories.length ? 'PARTIAL' : 'SUCCESS';
  return result;
}
