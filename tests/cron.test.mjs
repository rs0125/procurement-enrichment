import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createScheduledJob } from '../src/services/cron/scheduledJob.mjs';
import { sweepImages } from '../src/services/cron/imageSweeps.mjs';
import { createEnrichmentSweep } from '../src/services/cron/enrichmentSweep.mjs';
import { createWebpSweep } from '../src/services/cron/webpSweep.mjs';
import { sweepProximity } from '../src/services/cron/proximitySweep.mjs';
import { createExecutor } from '../src/lib/runtime/executor.mjs';
import { createStorage } from '../src/lib/images/storage.mjs';
import { sweepRoutes } from '../src/routes/sweeps.routes.mjs';
import { ENRICHMENT_ENDPOINT, planCronHandoff } from '../src/lib/runtime/cronHandoff.mjs';

function logs() {
  const rows = [];
  return { rows,
    async tryStart(jobName, staleAfterMs, metadata) {
      if (rows.some(row => row.jobName === jobName && row.status === 'RUNNING' && Date.now() - row.ranAt < staleAfterMs)) return null;
      const row = { id: BigInt(rows.length + 1), jobName, status: 'RUNNING', ranAt: new Date(), metadata };
      rows.push(row); return row;
    },
    async finish(id, status, durationMs, metadata) { Object.assign(rows.find(row => row.id === id), { status, durationMs, metadata }); },
    async recent(name) { return rows.filter(row => row.jobName === name).at(-1) ?? null; }
  };
}
const signal = () => new AbortController().signal;

test('cron handoff changes only the supported destination and credential, preserving schedule and request options', () => {
  const job = { jobid: 8n, jobname: 'sweep-warehouse-image-labels', active: true, schedule: '*/15 * * * *',
    command: "select net.http_post(url := 'https://u3yrpp3726.ap-south-1.awsapprunner.com/api/enrichment/sweep', headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret','old-test-key'),body := '{}'::jsonb,timeout_milliseconds := 120000);" };
  const plan = planCronHandoff(job, "new-test-key's-value");
  assert.equal(plan.summary.schedule, job.schedule); assert.equal(plan.summary.active, true);
  assert.ok(plan.command.includes(ENRICHMENT_ENDPOINT)); assert.ok(plan.command.includes("'Authorization', 'Bearer new-test-key''s-value'"));
  assert.ok(plan.command.includes('timeout_milliseconds := 120000'));
  assert.ok(!JSON.stringify(plan.summary).includes('key'));
  assert.equal(planCronHandoff({ ...job, command: plan.command }, "new-test-key's-value").summary.changed, false);
  assert.throws(() => planCronHandoff({ ...job, jobname: 'geocode-recent' }, 'key'));
  assert.throws(() => planCronHandoff({ ...job, command: job.command.replace('/api/enrichment/sweep', '/unexpected') }, 'key'));
});

test('cron acknowledges before work, shares the old database run lock and records completion', async () => {
  const runLog = logs(), scheduled = [];
  let calls = 0;
  const options = { jobName: 'sweep_warehouse_enrichment', runLog, budgetMs: 1000, schedule: fn => scheduled.push(fn),
    preview: async () => ({ status: 'DRY_RUN' }), work: async () => { calls++; return { status: 'SUCCESS', count: 3 }; } };
  const first = createScheduledJob(options), second = createScheduledJob(options);
  const [a, b] = await Promise.all([first.start(), second.start()]);
  assert.equal(a.status, 'accepted'); assert.equal(b.status, 'already_running'); assert.equal(a.jobId, b.jobId);
  assert.equal(calls, 0);
  await scheduled.shift()(); await first.drain();
  assert.equal(calls, 1); assert.equal((await first.status()).status, 'SUCCESS');
  assert.equal((await first.status()).progress.count, 3);
});

test('deadline and shutdown cancel running work and release it for the next cron', async () => {
  for (const shutdown of [false, true]) {
    const controller = new AbortController(), runLog = logs(), scheduled = [];
    const job = createScheduledJob({ jobName: 'test', runLog, budgetMs: shutdown ? 1000 : 10,
      shutdownSignal: controller.signal, schedule: fn => scheduled.push(fn),
      work: ({ signal }) => delay(200, undefined, { signal }) });
    await job.start(); const work = scheduled.shift()();
    if (shutdown) controller.abort();
    await work; await job.drain();
    assert.equal((await job.status()).status, 'PARTIAL');
    assert.ok(!JSON.stringify(await job.status()).includes('AbortError'));
    if (shutdown) await assert.rejects(job.start(), /stopping/);
    else assert.equal((await job.start()).status, 'accepted');
  }
});

test('database failure fails closed before accepting untracked work', async () => {
  let scheduled = false;
  const job = createScheduledJob({ jobName: 'test', budgetMs: 1000,
    runLog: { tryStart: async () => { throw new Error('db offline'); } }, schedule: () => { scheduled = true; } });
  await assert.rejects(job.start(), /offline/); assert.equal(scheduled, false);
});

test('overlapping crons share one worker without claiming waiting images or losing selected work', async () => {
  const execute = createExecutor({ available: async () => 1e9, rss: () => 1e6 });
  let active = 0, maximum = 0, processed = 0;
  const services = { run: (name, input) => execute(async () => {
    active++; maximum = Math.max(maximum, active); await delay(10); active--; processed++;
    return { status: 'READY', imageId: input.imageId };
  }) };
  function repository() {
    let selected = false;
    return { bounded: async method => method === 'backlog' ? {} : selected ? [] : (selected = true, [{ id: 1 }, { id: 2 }]) };
  }
  const results = await Promise.all(['label','webp'].map(stage => sweepImages({ repository: repository(), services,
    stage, service: stage, limit: 2, signal: signal() })));
  assert.equal(maximum, 1); assert.equal(processed, 4);
  assert.ok(results.every(result => result.ready === 2 && result.status === 'SUCCESS'));
});

test('memory pressure defers the rest of a batch without consuming its images', async () => {
  let calls = 0;
  const repository = { bounded: async (method, _stage, limit) => method === 'backlog' ? { PENDING: 2 } : [{ id: 1 }, { id: 2 }].slice(0, limit) };
  const result = await sweepImages({ repository, services: { run: async () => { calls++; return { status: 'DEFERRED', reason: 'memory_pressure' }; } },
    stage: 'webp', service: 'webp', limit: 2, signal: signal() });
  assert.equal(calls, 1); assert.equal(result.deferred, 2); assert.equal(result.status, 'PARTIAL');
});

test('preview is read-only; scene labels, document kinds and website approvals stay separate actions', async () => {
  const calls = [], remaining = new Set(['label','document','website']);
  const repository = { bounded: async (method, stage, limit) => {
    calls.push(method);
    if (method === 'backlog') return { PENDING: remaining.has(stage) ? 1 : 0 };
    if (method === 'pending') return remaining.delete(stage) ? [{ id: 1 }] : [];
    if (method === 'reconcile') return { registered: 0, retained: 0 };
  } };
  const actions = [];
  const proximity = { bounded: async method => method === 'coverage' ? [] : [] };
  const sweep = createEnrichmentSweep({ repository, proximity, runLog: logs(), configured: () => ({ images: true }),
    services: { run: async name => { actions.push(name); return { status: 'READY' }; } } });
  assert.equal((await sweep.preview()).status, 'DRY_RUN');
  assert.ok(calls.every(method => method === 'backlog')); assert.deepEqual(actions, []);
  assert.equal((await sweep.work({ signal: signal() })).status, 'SUCCESS');
  assert.deepEqual(actions, ['image-label', 'document-kind', 'website-approval']);
});

test('incomplete R2 inventories cannot reset completed WebPs or start compression', async () => {
  const methods = [];
  const sweep = createWebpSweep({ repository: { bounded: async method => { methods.push(method); return {}; } },
    services: { run: () => assert.fail('compression started') }, configured: () => true,
    getStore: () => ({ existingWebpKeys: async () => { throw new Error('listing interrupted'); } }) });
  await assert.rejects(sweep.work({ signal: signal() }), /interrupted/);
  assert.deepEqual(methods, ['reconcile', 'expireClaims']);
});

test('WebP sweeps repair legacy projections even with no pending images', async () => {
  let pages = 0, invalidations = 0;
  const sweep = createWebpSweep({ repository: { bounded: async method => {
    if (method === 'reconcile') return { registered: 0, retained: 0 };
    if (method === 'inventory' || method === 'pending') return [];
    if (method === 'backlog') return { READY: 2 };
    if (method === 'warehousePage') return pages++ ? [] : [{ id: 1 }];
    if (method === 'projectPage') return 1;
  } }, configured: () => true, getStore: () => ({ existingWebpKeys: async () => new Set() }),
    invalidate: async () => { invalidations++; }, services: { run: () => assert.fail('no work expected') } });
  const result = await sweep.work({ signal: signal() });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.projected, 1); assert.equal(invalidations, 1);
});

test('proximity failures retain cooldown metadata and stop further provider calls', async () => {
  const runLog = logs(); let called = 0;
  const result = await sweepProximity({ model: { bounded: async method => method === 'coverage' ? []
    : [{ id: 5, lat: 10, lng: 20 }, { id: 6, lat: 11, lng: 21 }] }, runLog, signal: signal(),
    services: { run: async () => { called++; throw new Error('private provider error'); } } });
  assert.equal(called, 1); assert.equal(result.failed, 1); assert.equal(result.deferred, 1);
  const log = await runLog.recent('warehouse_proximity:5');
  assert.equal(log.status, 'FAILED'); assert.equal(log.metadata.attempts, 1);
  assert.ok(Date.parse(log.metadata.retryAt) > Date.now());
});

test('R2 listing rejects an incomplete continuation and omits empty objects', async () => {
  const env = { R2_PUBLIC_URL: 'https://images.example', R2_BUCKET_NAME: 'test', R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test' };
  const client = { send: async () => ({ Contents: [{ Key: 'webp/a', Size: 10 }, { Key: 'webp/empty', Size: 0 }] }) };
  assert.deepEqual([...await createStorage(env, { client }).existingWebpKeys(signal())], ['webp/a']);
  client.send = async () => ({ IsTruncated: true });
  await assert.rejects(createStorage(env, { client }).existingWebpKeys(signal()), /incomplete/);
});

test('cron HTTP authentication, dry runs and the existing CMS WebP token contract', async () => {
  let starts = 0, previews = 0;
  const job = { start: async () => { starts++; return { status: 'accepted', jobId: '4' }; },
    preview: async () => { previews++; return { status: 'DRY_RUN' }; }, status: async () => ({ status: 'SUCCESS' }) };
  const old = process.env.R2_SECRET_ACCESS_KEY; process.env.R2_SECRET_ACCESS_KEY = 'test-storage-key';
  const app = express(); app.use(express.json()); app.use(sweepRoutes({ jobs: { enrichment: job, webp: job },
    authorize: (req, res, next) => req.get('authorization') === 'Bearer test-cron' ? next() : res.sendStatus(401) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/cron/enrichment', { method: 'POST' })).status, 401);
    const headers = { 'content-type': 'application/json', authorization: 'Bearer test-cron' };
    assert.equal((await fetch(base + '/cron/enrichment', { method: 'POST', headers, body: '{"dryRun":true}' })).status, 200);
    assert.equal(previews, 1); assert.equal(starts, 0);
    assert.equal((await fetch(base + '/cron/enrichment', { method: 'POST', headers, body: '{"limit":999}' })).status, 400);
    assert.equal((await fetch(base + '/maintenance/webp', { method: 'POST', headers })).status, 401);
    const token = createHmac('sha256', 'test-storage-key').update('wareongo:warehouse-webp-trigger:v1').digest('hex');
    const response = await fetch(base + '/maintenance/webp', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 202); assert.equal((await response.json()).jobId, '4'); assert.equal(starts, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.R2_SECRET_ACCESS_KEY; else process.env.R2_SECRET_ACCESS_KEY = old;
  }
});
