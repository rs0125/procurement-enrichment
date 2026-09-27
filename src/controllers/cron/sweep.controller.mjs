export function sweepController(job) {
  return {
    async start(req, res) {
      const input = req.body ?? {};
      if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'dryRun')
        || (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')) return res.status(400).json({ error: 'invalid_cron_input' });
      try {
        res.set('Cache-Control', 'no-store');
        if (input.dryRun) return res.json(await job.preview());
        return res.status(202).json(await job.start());
      } catch { return res.status(503).json({ error: 'cron_unavailable' }); }
    },
    async status(_req, res) {
      try { res.set('Cache-Control', 'no-store'); return res.json(await job.status()); }
      catch { return res.status(503).json({ error: 'cron_status_unavailable' }); }
    }
  };
}
