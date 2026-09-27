import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduledJob } from '../src/services/cron/scheduledJob.mjs';
import { errorHandler } from '../src/middlewares/errorHandler.mjs';
import { healthController } from '../src/controllers/health.controller.mjs';
import { createEnrichmentSweep } from '../src/services/cron/enrichmentSweep.mjs';
import { sweepImages } from '../src/services/cron/imageSweeps.mjs';
import { extractCoordinatesFromUrl } from '../src/lib/googleMaps/extractor.mjs';

test('shutdown waits for an in-flight cron acceptance and closes its persisted run', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const controller = new AbortController(), scheduled = [], finished = [];
  let drained = false, workCalls = 0;
  const job = createScheduledJob({ jobName: 'audit', budgetMs: 1000, shutdownSignal: controller.signal,
    schedule: fn => scheduled.push(fn), work: async () => { workCalls++; return { status: 'SUCCESS' }; },
    runLog: { tryStart: async () => { await waiting; return { id: 1n }; },
      finish: async (...args) => finished.push(args) } });
  const acceptance = job.start();
  const outcome = acceptance.then(value => ({ value }), error => ({ error }));
  controller.abort();
  const drain = job.drain().then(() => { drained = true; });
  await delay(5);
  const premature = drained;
  release();
  const result = await outcome;
  for (const callback of scheduled) await callback();
  await drain;
  assert.equal(premature, false, 'drain returned while acceptance was still writing to the database');
  assert.ok(result.error, 'a stopping worker acknowledged a new job');
  assert.equal(workCalls, 0);
  assert.equal(finished[0]?.[1], 'INTERRUPTED');
});

test('concurrent callers never get a successful acknowledgement if acceptance fails', async () => {
  let reject;
  const waiting = new Promise((_, fail) => { reject = fail; });
  const job = createScheduledJob({ jobName: 'audit', budgetMs: 1000,
    runLog: { tryStart: () => waiting, recent: async () => null } });
  const outcomes = Promise.allSettled([job.start(), job.start()]);
  reject(new Error('database unavailable'));
  assert.deepEqual((await outcomes).map(result => result.status), ['rejected', 'rejected']);
});

test('unexpected errors do not expose private exception messages in responses or logs', () => {
  const secret = 'synthetic-private-database-credential';
  const logs = [], result = {};
  const original = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const response = { status(code) { result.code = code; return this; }, json(body) { result.body = body; } };
    errorHandler(new Error(secret), { method: 'POST', path: '/audit' }, response, () => {});
    assert.equal(result.code, 500);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(logs.map(args => args.map(value => value?.message ?? value))).includes(secret));
  } finally { console.error = original; }
});

test('public health responds generically when a database error contains credentials', async () => {
  const result = {};
  const response = { set() {}, status(code) { result.code = code; return this; }, json(body) { result.body = body; } };
  await healthController({ $queryRaw: async () => { throw new Error('synthetic-private-database-credential'); } })({}, response);
  assert.equal(result.code, 503);
  assert.deepEqual(result.body, { status: 'error', db: 'unavailable' });
});

test('a stage audit failure does not suppress independent website and proximity stages', async () => {
  for (const failure of ['tryStart','finish']) {
    const calls = [], remaining = new Set(['label','document','website']);
    const repository = { bounded: async (method, stage) => method === 'pending'
      ? remaining.delete(stage) ? [{ id: 1 }] : [] : {} };
    const runLog = { tryStart: async name => {
      if (failure === 'tryStart' && name === 'sweep_warehouse_image_labels') throw new Error('audit unavailable');
      return { id: name };
    }, finish: async id => { if (failure === 'finish' && id === 'sweep_warehouse_image_labels') throw new Error('audit unavailable'); } };
    const sweep = createEnrichmentSweep({ repository, runLog, configured: () => true,
      proximity: { bounded: async () => { calls.push('proximity'); return []; } },
      services: { run: async name => { calls.push(name); return { status: 'READY' }; } } });
    const result = await sweep.work({ signal: new AbortController().signal });
    assert.equal(result.status, 'PARTIAL');
    assert.ok(calls.includes('website-approval'));assert.ok(calls.includes('proximity'));
  }
});

test('exhausted or unsupported backlog is visible even when no retries are due', async () => {
  for (const status of ['FAILED','UNSUPPORTED','RUNNING','PENDING']) {
    const result = await sweepImages({ stage: 'label', service: 'image-label', limit: 50,
      signal: new AbortController().signal,
      services: { run: () => assert.fail('no retry was due') },
      repository: { bounded: async method => method === 'backlog' ? { [status]: 1 } : [] } });
    assert.equal(result.hasMore, false);assert.equal(result.status, 'PARTIAL', status);
  }
});

test('a lookalike Maps URL cannot cause the worker to request an internal or unrelated host', async () => {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async url => { calls.push(url); return { url: 'https://www.google.com/maps?q=12.3,77.4' }; };
  try {
    for (const url of ['http://127.0.0.1/?goo.gl','https://goo.gl.attacker.invalid/','https://attacker.invalid/?share.google']) {
      const result = await extractCoordinatesFromUrl(url);
      assert.equal(result.lat, null);
    }
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = original; }
});
