import { setTimeout as delay } from 'node:timers/promises';
import { invoke } from './imageSweeps.mjs';
import { diagnostic,operation } from '../../lib/runtime/diagnostics.mjs';

export function createGeocodeRecentSweep({ repository, services, pause = delay, limit = 100 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid geocoder batch size');
  async function selection() {
    const rows = await repository.pending(limit + 1);
    return { rows: rows.slice(0, limit), morePending: rows.length > limit };
  }
  return {
    async preview() {
      const { rows, morePending } = await selection();
      return { status: 'DRY_RUN', scope: 'recent-7d', candidates: rows.length, limit, morePending };
    },
    async work({ signal,jobId,jobName='geocode-recent' }) {
      const context={jobId,jobName,action:'geocode'};
      signal.throwIfAborted();
      const { rows, morePending } = await operation({...context,operation:'select_candidates'},selection);
      const result = { scope: 'recent-7d', candidates: rows.length, processed: 0, succeeded: 0,
        failed: 0, skipped: 0, deferred: 0, morePending };
      if(services.deliveryMode==='queue') Object.assign(result,{reporting:'dispatch',queued:0});
      for (const warehouse of rows) {
        if (signal.aborted) break;
        let item;
        try { item = await invoke(services, 'geocode', { warehouseId: warehouse.id }, signal); }
        catch(error) { if (signal.aborted) break; result.failed++; result.processed++;
          result.diagnostic=diagnostic(error,{...context,subjectId:warehouse.id,operation:'dispatch'});break; }
        if (item.status === 'DEFERRED') break;
        result.processed++;
        if (item.status === 'READY') result.succeeded++;
        else if(item.status==='QUEUED') result.queued=(result.queued??0)+1;
        else if (item.status === 'FAILED') result.failed++;
        else result.skipped++;
        if (services.deliveryMode!=='queue' && result.processed < rows.length) {
          try { await pause(2000, undefined, { signal }); } catch { break; }
        }
      }
      result.deferred = rows.length - result.processed;
      if(services.deliveryMode==='queue') {
        result.dispatchStatus=result.queued===rows.length && !signal.aborted?'SUCCESS':result.queued || result.deferred || signal.aborted?'PARTIAL':'FAILED';
        result.processingStatus=rows.length || morePending?'OUTSTANDING':'CURRENT';
        result.status=result.dispatchStatus;return result;
      }
      result.status = result.failed === result.candidates && result.candidates > 0 ? 'FAILED'
        : result.failed || result.skipped || result.deferred || morePending ? 'PARTIAL' : 'SUCCESS';
      return result;
    }
  };
}
