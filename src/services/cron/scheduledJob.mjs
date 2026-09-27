export function createScheduledJob({ jobName, runLog, work, preview, budgetMs, shutdownSignal,
  schedule = setImmediate, now = Date.now }) {
  const staleAfterMs = budgetMs + 5 * 60000;
  let starting = false, completion = null;

  async function status() {
    const row = await runLog.recent(jobName);
    if (!row) return { status: 'idle' };
    const interrupted = row.status === 'RUNNING' && now() - new Date(row.ranAt).getTime() > staleAfterMs;
    return { jobId: String(row.id), status: interrupted ? 'INTERRUPTED' : row.status,
      startedAt: row.ranAt, durationMs: row.durationMs, progress: row.metadata };
  }

  return {
    status, preview,
    drain: async () => { await completion; },
    async start() {
      if (shutdownSignal?.aborted) throw new Error('Worker is stopping');
      if (starting || completion) return { status: 'already_running', jobId: (await status()).jobId ?? jobName };
      starting = true;
      try {
        const run = await runLog.tryStart(jobName, staleAfterMs, { executor: 'warehouse-enricher' });
        if (!run) return { status: 'already_running', jobId: (await status()).jobId ?? jobName };
        const started = now();
        let resolve;
        completion = new Promise(done => { resolve = done; });
        schedule(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), budgetMs);
          timer.unref?.();
          const signal = shutdownSignal ? AbortSignal.any([shutdownSignal, controller.signal]) : controller.signal;
          let result;
          try { result = await work({ signal }); }
          catch { result = { status: signal.aborted ? 'PARTIAL' : 'FAILED', reason: signal.aborted ? 'interrupted' : 'sweep_failed' }; }
          finally { clearTimeout(timer); }
          try { await runLog.finish(run.id, result.status, now() - started, { executor: 'warehouse-enricher', ...result }); }
          catch { console.error('Cron audit completion failed', { jobName }); }
          finally { completion = null; resolve(); }
        });
        return { status: 'accepted', jobId: String(run.id) };
      } finally { starting = false; }
    }
  };
}
