import { setTimeout as delay } from 'node:timers/promises';
import { diagnostic,operation } from '../../lib/runtime/diagnostics.mjs';

export async function invoke(services, name, input, signal) {
  while (true) {
    signal.throwIfAborted();
    const result = await (services.reconcile ?? services.run).call(services, name, { ...input, signal });
    if (result.reason !== 'worker_busy') return result;
    await delay(250, undefined, { signal });
  }
}

export async function sweepImages({ repository, services, stage, service, limit, signal,jobId,jobName }) {
  const result = { status: 'SUCCESS', processed: 0, ready: 0, failed: 0, deferred: 0, unsupported: 0, stale: 0 };
  const queued=services.deliveryMode==='queue',context={jobId,jobName,action:service};
  if(queued) Object.assign(result,{reporting:'dispatch',selected:0,queued:0});
  // Select IDs only. The discrete action claims each row when it can start work.
  const rows = await operation({...context,operation:'select_candidates'},()=>repository.bounded('pending', stage, limit));
  if(queued) result.selected=rows.length;
  for (const row of rows) {
    if (signal.aborted) { result.deferred += rows.length - result.processed; break; }
    let item;
    try { item = await invoke(services, service, { imageId: row.id }, signal); }
    catch (error) {
      if (signal.aborted) { result.deferred += rows.length - result.processed; break; }
      if (error.statusCode === 503) await operation({...context,operation:'dispatch',subjectId:row.id},()=>{throw error;});
      if((result.errors??=[]).length<5) result.errors.push(diagnostic(error,{...context,operation:'dispatch',subjectId:row.id}));
      item = { status: 'FAILED' };
    }
    result.processed++;
    if (item.status === 'QUEUED') result.queued=(result.queued??0)+1;
    if (item.status === 'READY') result.ready++;
    if (item.status === 'FAILED') result.failed++;
    if (item.status === 'UNSUPPORTED') result.unsupported++;
    if (item.status === 'STALE') result.stale++;
    if (item.status === 'DEFERRED') {
      result.deferred += rows.length - result.processed + 1;
      break;
    }
  }
  result.backlog = await operation({...context,operation:'backlog'},()=>repository.bounded('backlog', stage));
  result.hasMore = (await operation({...context,operation:'select_candidates'},()=>repository.bounded('pending', stage, 1))).length > 0;
  const unresolved = ['PENDING','FAILED','RUNNING','UNSUPPORTED'].some(status => result.backlog[status] > 0);
  if(queued) {
    // Queued work remains PENDING until the independent consumer claims it.
    // Those domain states describe processing, not failure of this dispatch run.
    result.dispatchStatus=result.queued===rows.length && !signal.aborted ? 'SUCCESS'
      : result.queued>0 || result.deferred>0 || signal.aborted ? 'PARTIAL' : 'FAILED';
    result.processingStatus=unresolved?'OUTSTANDING':'CURRENT';
    result.status=result.dispatchStatus;
    return result;
  }
  result.status = result.failed ? result.ready ? 'PARTIAL' : 'FAILED'
    : result.deferred || result.hasMore || result.stale || result.unsupported || unresolved ? 'PARTIAL' : 'SUCCESS';
  return result;
}
