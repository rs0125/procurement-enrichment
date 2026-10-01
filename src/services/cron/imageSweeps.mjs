import { setTimeout as delay } from 'node:timers/promises';

export async function invoke(services, name, input, signal) {
  while (true) {
    signal.throwIfAborted();
    const result = await (services.reconcile ?? services.run).call(services, name, { ...input, signal });
    if (result.reason !== 'worker_busy') return result;
    await delay(250, undefined, { signal });
  }
}

export async function sweepImages({ repository, services, stage, service, limit, signal }) {
  const result = { status: 'SUCCESS', processed: 0, ready: 0, failed: 0, deferred: 0, unsupported: 0, stale: 0 };
  // Select IDs only. The discrete action claims each row when it can start work.
  const rows = await repository.bounded('pending', stage, limit);
  for (const row of rows) {
    if (signal.aborted) { result.deferred += rows.length - result.processed; break; }
    let item;
    try { item = await invoke(services, service, { imageId: row.id }, signal); }
    catch (error) {
      if (signal.aborted) { result.deferred += rows.length - result.processed; break; }
      if (error.statusCode === 503) throw error;
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
  result.backlog = await repository.bounded('backlog', stage);
  result.hasMore = (await repository.bounded('pending', stage, 1)).length > 0;
  const unresolved = ['PENDING','FAILED','RUNNING','UNSUPPORTED'].some(status => result.backlog[status] > 0);
  result.status = result.failed ? result.ready ? 'PARTIAL' : 'FAILED'
    : result.deferred || result.hasMore || result.stale || result.unsupported || unresolved ? 'PARTIAL' : 'SUCCESS';
  return result;
}
