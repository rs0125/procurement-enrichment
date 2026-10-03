import { diagnostic,reportDiagnostic } from '../../lib/runtime/diagnostics.mjs';

export function createScheduledJob({ jobName, runLog, work, preview, budgetMs, shutdownSignal,
  schedule = setImmediate, now = Date.now }) {
  const staleAfterMs = budgetMs + 5 * 60000;
  let starting = null, completion = null, activeJobId = null;

  async function status() {
    const row = await runLog.recent(jobName);
    if (!row) return { status: 'idle' };
    const interrupted = row.status === 'RUNNING' && now() - new Date(row.ranAt).getTime() > staleAfterMs;
    return { jobId: String(row.id), status: interrupted ? 'INTERRUPTED' : row.status,
      startedAt: row.ranAt, durationMs: row.durationMs, progress: row.metadata };
  }

  async function accept() {
    const run = await runLog.tryStart(jobName, staleAfterMs, { executor: 'warehouse-enricher' });
    if (!run) {
      const current = await status();
      if (current.status !== 'RUNNING') throw new Error('Cron acceptance contended; retry');
      return { status: 'already_running', jobId: current.jobId };
    }
    const started = now();
    if (shutdownSignal?.aborted) {
      await runLog.finish(run.id, 'INTERRUPTED', 0, { executor: 'warehouse-enricher', reason: 'worker_stopping' });
      throw new Error('Worker is stopping');
    }
    activeJobId = String(run.id);
    let resolve;
    completion = new Promise(done => { resolve = done; });
    const execute = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      timer.unref?.();
      const signal = shutdownSignal ? AbortSignal.any([shutdownSignal, controller.signal]) : controller.signal;
      let result;
      try {
        signal.throwIfAborted();
        result = await work({ signal,jobName,jobId:String(run.id) });
        if (!['SUCCESS','PARTIAL','FAILED','INTERRUPTED'].includes(result?.status)) throw new Error('Invalid cron result');
      }
      catch(error) { result = { status: signal.aborted ? 'PARTIAL' : 'FAILED', reason: signal.aborted ? 'interrupted' : 'sweep_failed',
        diagnostic:reportDiagnostic(error,{jobName,jobId:run.id,operation:'run'}) }; }
      finally { clearTimeout(timer); }
      try { await runLog.finish(run.id, result.status, now() - started, { executor: 'warehouse-enricher', ...result }); }
      catch(error) { reportDiagnostic(error,{jobName,jobId:run.id,operation:'record_completion'}); }
      finally { completion = null; activeJobId = null; resolve(); }
    };
    try { schedule(execute); }
    catch (error) {
      try { await runLog.finish(run.id, 'FAILED', now() - started, { executor: 'warehouse-enricher', reason: 'schedule_failed',
        diagnostic:diagnostic(error,{jobName,jobId:run.id,operation:'schedule'}) }); }
      finally { completion = null; activeJobId = null; resolve(); }
      throw error;
    }
    return { status: 'accepted', jobId: String(run.id) };
  }

  return {
    status, preview,
    drain: async () => { await starting?.catch(() => {}); await completion; },
    async start() {
      if (shutdownSignal?.aborted) throw new Error('Worker is stopping');
      if (starting) return { ...await starting, status: 'already_running' };
      if (completion) return { status: 'already_running', jobId: activeJobId };
      starting = accept();
      try { return await starting; }
      finally { starting = null; }
    }
  };
}
