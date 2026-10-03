import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { QueueRepository } from '../src/models/queue/repository.mjs';
import { QueueSourceRepository } from '../src/models/queue/sourceRepository.mjs';
import { createQueueConsumer } from '../src/services/queue/consumer.mjs';
import { createQueuePlanner } from '../src/services/queue/planner.mjs';
import { request } from '../src/lib/queue/contract.mjs';
import { queueActionCases } from './fixtures/queueActionCases.mjs';
import { createQueueRuntime } from '../src/services/queue/runtime.mjs';
import { queueSettings } from '../src/lib/queue/settings.mjs';

const url = process.env.ENRICHER_QUEUE_TEST_DATABASE_URL;
test('PGMQ queue integration (disposable local database only)', {skip: !url}, async t => {
  const parsed = new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));
  assert.equal(parsed.pathname, '/enricher_queue_test');
  const pool = new pg.Pool({connectionString: url, max: 5, statement_timeout: 10000});
  const queue = new QueueRepository(pool);
  const script = async name => pool.query(await readFile(new URL('../sql/queue/' + name, import.meta.url), 'utf8'));
  const clear = () => pool.query('TRUNCATE pgmq.q_enrichment_jobs,pgmq.a_enrichment_jobs,pgmq.q_enrichment_dead,pgmq.a_enrichment_dead');
  const release = id => pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=clock_timestamp()-interval '1 second' WHERE msg_id=$1", [id]);
  const send = async (action = 'webp', id = 1) => { await queue.enqueue(request(action, id)); return queue.claim(action, 'live'); };
  const lockSource = async client => (await client.query('SELECT id FROM public.queue_publication WHERE id=1 FOR UPDATE')).rowCount === 1;
  const write = client => client.query('UPDATE public.queue_publication SET result=result+1 WHERE id=1');
  try {
    await pool.query(`DROP SCHEMA IF EXISTS enrichment CASCADE;
      DROP EXTENSION IF EXISTS pgmq CASCADE;
      DROP SCHEMA IF EXISTS pgmq CASCADE;
      DROP TABLE IF EXISTS public.queue_publication,public.labeled_warehouse_images,public."GeocodeAttempt",public."WarehouseData",public."Warehouse" CASCADE;
      CREATE TABLE public.queue_publication(id int PRIMARY KEY,result int DEFAULT 0);
      INSERT INTO public.queue_publication(id) VALUES(1);
      CREATE TABLE public."Warehouse"(id int PRIMARY KEY,media jsonb,photos text,"photosWebp" text,visibility boolean DEFAULT true,
        "googleLocation" text,"createdAt" timestamp DEFAULT now(),"status_updated_at" timestamp);
      CREATE TABLE public."WarehouseData"(id serial PRIMARY KEY,"warehouseId" int UNIQUE REFERENCES public."Warehouse"(id),latitude float8,longitude float8);
      CREATE TABLE public."GeocodeAttempt"(id serial PRIMARY KEY,"warehouseId" int UNIQUE,"attemptCount" int DEFAULT 0,"lastAttemptAt" timestamp,"succeededAt" timestamp);
      CREATE TABLE public.labeled_warehouse_images(id int PRIMARY KEY,"imageUrl" text UNIQUE,classification text,"documentKind" text,
        "jpegStatus" text,"jpegUrl" text,"jpegVersion" text,"websiteOverride" jsonb,
        ${['label','document','website','webp'].map(s => `"${s}Status" text DEFAULT 'PENDING',"${s}Attempts" int DEFAULT 0,"${s}LeaseUntil" timestamptz,"${s}NextAttemptAt" timestamptz`).join(',')});
      DO $$ BEGIN
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;`);
    await pool.query(await readFile(new URL('./fixtures/queueDomain.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('./imageUrls.sql', import.meta.url), 'utf8'));
    await script('001_bootstrap.sql');
    await script('002_capture_functions.sql');
    await script('005_operational_alerts.sql');

    await t.test('bootstrap is additive and repeatable, with capture disabled', async () => {
      await queue.enqueue(request('webp', 1));
      await script('001_bootstrap.sql');
      await script('002_capture_functions.sql');
      const health = await queue.doctor();
      assert.equal(health.ready, true); assert.equal(health.source_capture_enabled, false);
      assert.equal(health.actionAdaptersAvailable, true);
      assert.equal((await queue.stats()).pending, 1);
      await clear();
    });
    await t.test('restricted trial leaves other subjects durable without attempts or dead letters',async()=>{
      await clear();await queue.enqueue(request('jpeg',99));let called=0;
      const consumer=createQueueConsumer({queue,execute:fn=>fn(),dispatch:async()=>{called++;return {kind:'done'};},
        settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue',ENRICHMENT_QUEUE_TRIAL_SUBJECTS:'{"warehouseIds":[1],"imageIds":[2]}'})});
      try {assert.equal((await consumer.tick()).state,'trial_deferred');}finally{consumer.stop();await consumer.drain();}
      assert.equal(called,0);const pending=await queue.stats();assert.equal(pending.pending,1);assert.equal(pending.dead,0);
      const {rows:[row]}=await pool.query('SELECT msg_id::text,headers FROM pgmq.q_enrichment_jobs');
      assert.ok(!row.headers?.deliveryFailures);await release(row.msg_id);
      const regular=createQueueConsumer({queue,execute:fn=>fn(),dispatch:async()=>{called++;return {kind:'done'};},settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'})});
      try {assert.equal((await regular.tick()).state,'completed');assert.equal(called,1);}finally{regular.stop();await regular.drain();}
      await clear();
    });
    await t.test('database alert flags exclude cooldowns, detect stopped workers and retain UTC backup age',async()=>{
      await clear();
      await script('005_operational_alerts.sql');
      await queue.enqueue(request('geocode',1),{delay:86400});
      await pool.query("UPDATE pgmq.q_enrichment_jobs SET enqueued_at=now()-interval '3 days'");
      await pool.query(`INSERT INTO "CronRunLog"("jobName",status,"durationMs","ranAt") VALUES('backup-db','success',10,(now() AT TIME ZONE 'UTC')-interval '1 hour')`);
      const read=async()=>Object.fromEntries((await queue.alerts()).map(row=>[row.code,row]));
      const first=await read();
      assert.equal(first.queue_live_delayed.active,false);assert.equal(first.queue_backfill_delayed.active,false);
      assert.equal(first.worker_heartbeat_stale.active,true);assert.equal(first.worker_heartbeat_stale.missing_observation,true);
      assert.equal(first.backup_overdue.active,false);assert.ok(Math.abs(first.backup_overdue.observed_value-3600)<5);
      const leader=await pool.connect();
      try {
        const {rows:[row]}=await leader.query('SELECT pg_backend_pid() AS pid,pg_advisory_lock(19870430,2)');
        assert.equal(await queue.recordHeartbeat(row.pid,{startedAt:new Date(),lastPollAt:new Date(),lastCompletedAt:null,healthy:true}),true);
        assert.equal((await read()).worker_heartbeat_stale.active,false);
        assert.equal((await read()).worker_poll_stale.active,false);
        await leader.query('SELECT pg_advisory_unlock(19870430,2)');
        assert.equal(await queue.recordHeartbeat(row.pid,{startedAt:new Date(),lastPollAt:new Date(),healthy:true}),false);
      } finally {leader.release(true);}
      await pool.query("UPDATE enrichment.worker_heartbeat SET seen_at=now()-interval '4 minutes',last_poll_at=now()-interval '6 minutes'");
      const stopped=await read();assert.equal(stopped.worker_heartbeat_stale.active,true);assert.equal(stopped.worker_poll_stale.active,true);
      const live=await queue.enqueue(request('webp',2));const backfill=await queue.enqueue(request('webp',3,'backfill'));
      await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=now()-interval '16 minutes' WHERE msg_id=$1",[live.messageId]);
      await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=now()-interval '61 minutes' WHERE msg_id=$1",[backfill.messageId]);
      const overdue=await read();assert.equal(overdue.queue_live_delayed.active,true);assert.equal(overdue.queue_backfill_delayed.active,true);
      assert.equal((await queue.stats()).pending,3);await clear();
      await pool.query("DELETE FROM \"CronRunLog\" WHERE \"jobName\"='backup-db'");
      const missing=await read();assert.equal(missing.backup_overdue.active,true);assert.equal(missing.backup_overdue.observed_value,null);
      for(const role of ['anon','authenticated']) {
        const client=await pool.connect();
        try {
          await client.query('BEGIN');await client.query('SET LOCAL ROLE '+role);
          await assert.rejects(client.query('SELECT * FROM enrichment.alert_status'),{code:'42501'});
        }finally {await client.query('ROLLBACK');client.release();}
      }
      await pool.query('DELETE FROM enrichment.worker_heartbeat');
    });
    await t.test('real worker leadership excludes competitors and fences a terminated database session',async()=>{
      await clear();let failure;
      const lost=new Promise(resolve=>{failure=resolve;});
      const runtime=()=>createQueueRuntime({queue,prisma:{},services:{stop(){}},execute:fn=>fn(),
        settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'}),heartbeatMs:25});
      const first=runtime(),second=runtime(),replacement=runtime();
      try {
        first.onFailure(failure);await first.start();
        await assert.rejects(second.start(),/already active/);
        const {rows:[lock]}=await pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory'
          AND classid=19870430 AND objid=2 AND objsubid=2 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
        assert.ok(lock?.pid);await pool.query('SELECT pg_terminate_backend($1)',[lock.pid]);
        await Promise.race([lost,delay(2000).then(()=>{throw new Error('Worker did not fence itself');})]);
        assert.equal(first.status().healthy,false);await first.drain();
        await replacement.start();assert.equal(replacement.status().healthy,true);
      } finally {await Promise.all([first.drain(),second.drain(),replacement.drain()]);}
    });
    await t.test('only backend role can use private wrappers; no raw queue table access', async () => {
      for (const role of ['anon','authenticated','enrichment_queue_worker']) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN'); await client.query('SET LOCAL ROLE ' + role);
          if (role === 'enrichment_queue_worker') {
            await client.query('SELECT enrichment.enqueue($1::jsonb,0)', [request('webp', 1)]);
          } else await assert.rejects(client.query('SELECT enrichment.enqueue($1::jsonb,0)', [request('webp', 1)]), {code: '42501'});
          await client.query('ROLLBACK'); await client.query('BEGIN'); await client.query('SET LOCAL ROLE ' + role);
          await assert.rejects(client.query('SELECT * FROM pgmq.q_enrichment_jobs'), {code: '42501'});
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      const workerPool = new pg.Pool({connectionString:url,max:1,onConnect:client=>client.query('SET ROLE enrichment_queue_worker')});
      try { assert.equal((await new QueueRepository(workerPool).doctor()).ready,true); }
      finally { await workerPool.end(); }
    });
    await t.test('SQL boundary independently validates payload and delay', async () => {
      for (const input of [null, [], {...request('webp', 1), secret:'no'}, {...request('webp', 1), subjectId:1}, {...request('webp',1), subjectId:'2147483648'}]) {
        await assert.rejects(pool.query('SELECT enrichment.enqueue($1::jsonb,0)', [JSON.stringify(input)]), {code:'22023'});
      }
      await assert.rejects(pool.query('SELECT enrichment.enqueue($1::jsonb,-1)', [request('webp',1)]), {code:'22023'});
      assert.equal((await queue.stats()).pending, 0);
    });
    await t.test('source capture is transactional, ignores derived edits and can be disabled', async () => {
      await script('003_enable_capture.sql');
      await pool.query(`INSERT INTO public."Warehouse"(id,media) VALUES(10,'{"images":["https://images.example/one.jpg"]}')`);
      assert.equal((await queue.stats()).pending, 1);
      await pool.query(`UPDATE public."Warehouse" SET "photosWebp"='["derived.webp"]' WHERE id=10`);
      assert.equal((await queue.stats()).pending, 1);
      await pool.query(`UPDATE public."Warehouse" SET visibility=false WHERE id=10`);
      await pool.query(`INSERT INTO public."WarehouseData"("warehouseId",latitude,longitude) VALUES(10,12,77)`);
      await pool.query(`UPDATE public."WarehouseData" SET latitude=latitude WHERE "warehouseId"=10`);
      assert.equal((await queue.stats()).pending, 3);
      await assert.rejects(queue.transaction(async client => {
        await client.query(`UPDATE public."Warehouse" SET visibility=true WHERE id=10`);
        throw new Error('save rejected');
      }), /save rejected/);
      assert.equal((await queue.stats()).pending, 3);
      assert.equal((await pool.query('SELECT visibility FROM public."Warehouse" WHERE id=10')).rows[0].visibility, false);
      // A failing enqueue aborts the source save in the same transaction.
      await pool.query(`ALTER TABLE pgmq.q_enrichment_jobs ADD CONSTRAINT fixture_no_messages CHECK(false) NOT VALID`);
      await assert.rejects(pool.query(`UPDATE public."Warehouse" SET visibility=true WHERE id=10`), {code:'23514'});
      await pool.query('ALTER TABLE pgmq.q_enrichment_jobs DROP CONSTRAINT fixture_no_messages');
      assert.equal((await pool.query('SELECT visibility FROM public."Warehouse" WHERE id=10')).rows[0].visibility, false);
      await script('004_disable_capture.sql');
      await pool.query(`UPDATE public."Warehouse" SET visibility=true WHERE id=10`);
      assert.equal((await queue.stats()).pending, 3);
      await clear();
    });
    await t.test('concurrent reads are exclusive and unacknowledged work redelivers', async () => {
      await queue.enqueue(request('webp',1));
      const deliveries = (await Promise.all([queue.claim('webp','live'),queue.claim('webp','live')])).filter(Boolean);
      assert.equal(deliveries.length, 1);
      await release(deliveries[0].msg_id);
      const next = await queue.claim('webp','live');
      assert.equal(next.msg_id, deliveries[0].msg_id); assert.equal(next.read_ct, 2);
      await clear();
    });
    await t.test('expired/stale owners cannot publish, acknowledge, reject or reschedule', async () => {
      const old = await send(); await release(old.msg_id);
      assert.equal(await queue.finish(old), false);
      const current = await queue.claim('webp','live');
      assert.equal(await queue.finish(old), false);
      assert.equal(await queue.defer(old,300), false); assert.equal(await queue.reject(old,'obsolete'), false);
      assert.deepEqual(await queue.failDelivery(old), {kind:'stale'});
      assert.equal((await queue.withReceipt(old,{lockSource,write})).published, false);
      assert.equal((await queue.withReceipt(current,{lockSource,write})).published, true);
      assert.equal(await queue.finish(current), true); await clear();
    });
    await t.test('receipt expires while waiting for a row lock: publication is refused', async () => {
      const delivery = await send();
      await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=clock_timestamp()+interval '200 milliseconds' WHERE msg_id=$1", [delivery.msg_id]);
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT msg_id FROM pgmq.q_enrichment_jobs WHERE msg_id=$1 FOR UPDATE',[delivery.msg_id]);
        const waiting = queue.withReceipt(delivery,{lockSource,write});
        await delay(350); await locker.query('COMMIT');
        assert.equal((await waiting).published,false);
      } finally { await locker.query('ROLLBACK'); locker.release(); }
      await clear();
    });
    await t.test('publication requires current source; failures and aborts roll back writes', async () => {
      const delivery = await send();
      const before = (await pool.query('SELECT result FROM public.queue_publication WHERE id=1')).rows[0].result;
      assert.deepEqual(await queue.withReceipt(delivery,{lockSource:async()=>false,write}), {published:false,reason:'source_changed'});
      await assert.rejects(queue.withReceipt(delivery,{lockSource,write:async client=>{await write(client);throw new Error('publication failed');}}), /publication failed/);
      const abort = new AbortController();
      await assert.rejects(queue.withReceipt(delivery,{lockSource,signal:abort.signal,write:async client=>{await write(client);abort.abort();}}), {name:'AbortError'});
      assert.equal((await pool.query('SELECT result FROM public.queue_publication WHERE id=1')).rows[0].result,before);
      await clear();
    });
    await t.test('finish atomically enqueues follow-ups and archives parent', async () => {
      const delivery = await send('image-label');
      await assert.rejects(pool.query('SELECT enrichment.finish($1,$2,$3)',[delivery.msg_id,delivery.read_ct,JSON.stringify([request('document-kind',1),{bad:true}])]),{code:'22023'});
      assert.equal((await queue.stats()).pending,1); assert.equal((await queue.stats()).archived,0);
      assert.equal(await queue.finish(delivery,[request('document-kind',1),request('webp',1)]),true);
      const state = await queue.stats(); assert.equal(state.pending,2); assert.equal(state.archived,1);
      await clear();
    });
    await t.test('deferrals do not consume error budget; five caught errors dead-letter', async () => {
      let delivery = await send();
      for(let i=0;i<6;i++) { assert.equal(await queue.defer(delivery,1),true); await release(delivery.msg_id); delivery=await queue.claim('webp','live'); }
      for(let i=1;i<=5;i++) {
        const result = await queue.failDelivery(delivery); assert.equal(result.failures,i);
        if(i<5) { assert.equal(result.delaySeconds,300*2**(i-1)); await release(delivery.msg_id); delivery=await queue.claim('webp','live'); }
        else assert.equal(result.kind,'terminal');
      }
      const state = await queue.stats(); assert.equal(state.pending,0);assert.equal(state.dead,1);assert.equal(state.archived,1);
      const dead=(await pool.query('SELECT message FROM pgmq.q_enrichment_dead')).rows[0].message;
      assert.equal(dead.reason,'delivery_failures_exhausted');
      await clear();
    });
    await t.test('archive pruning is bounded and retains recent archive and dead letters', async () => {
      for(let i=0;i<3;i++) await queue.finish(await send());
      await queue.reject(await send(),'fixture_terminal');
      await pool.query("UPDATE pgmq.a_enrichment_jobs SET archived_at=now()-interval '31 days' WHERE msg_id IN (SELECT msg_id FROM pgmq.a_enrichment_jobs ORDER BY msg_id LIMIT 2)");
      assert.equal((await pool.query('SELECT enrichment.prune_archive(1) AS n')).rows[0].n,1);
      assert.equal((await pool.query('SELECT enrichment.prune_archive(1000) AS n')).rows[0].n,1);
      const state=await queue.stats(); assert.equal(state.archived,2);assert.equal(state.dead,1);
      await clear();
    });
    await t.test('planner uses current media membership, retry eligibility and bounded fan-out', async () => {
      await pool.query(`INSERT INTO public.labeled_warehouse_images(id,"imageUrl") VALUES(1,'https://images.example/one.jpg')`);
      const sources=new QueueSourceRepository(pool), planner=createQueuePlanner({sources});
      let result=await planner.preview(10); assert.equal(result.jobs.length,3);
      await pool.query(`UPDATE public.labeled_warehouse_images SET "websiteStatus"='READY',"webpAttempts"=5 WHERE id=1`);
      assert.deepEqual((await planner.preview(10)).jobs.map(j=>j.action),['image-label']);
      await pool.query(`UPDATE public."Warehouse" SET media='{"images":[]}',photos='["https://images.example/one.jpg"]' WHERE id=10`);
      assert.equal((await planner.preview(10)).jobs.length,0);
      await pool.query(`UPDATE public."Warehouse" SET media=$1,"googleLocation"='https://maps.example/a' WHERE id=10`,[JSON.stringify({images:Array.from({length:201},(_,i)=>'https://images.example/'+i+'.jpg')})]);
      assert.equal((await planner.preview(10)).status,'BLOCKED');
      await pool.query(`INSERT INTO public."Warehouse"(id,"googleLocation") VALUES(20,'https://maps.example/b')`);
      assert.deepEqual((await planner.preview(20)).jobs.map(j=>j.action),['geocode']);
      await pool.query(`INSERT INTO public."GeocodeAttempt"("warehouseId","attemptCount","lastAttemptAt") VALUES(20,1,now())`);
      assert.equal((await planner.preview(20)).jobs.length,0);
    });
    await t.test('consumer redelivery reuses persisted domain result without repeating external work', async () => {
      await pool.query('UPDATE public.queue_publication SET result=0 WHERE id=1');
      await queue.enqueue(request('webp',1));
      let calls=0, loseAck=true;
      const injected=Object.create(queue);
      injected.finish=async (...args)=>{ if(loseAck) {loseAck=false;throw new Error('connection lost before ack');}return queue.finish(...args); };
      const consumer=createQueueConsumer({queue:injected,settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue',ENRICHMENT_PROCESS_ROLE:'worker'}),execute:fn=>fn(),
        dispatch:async (input,ctx)=>{
          const ready=(await pool.query('SELECT result FROM public.queue_publication WHERE id=1')).rows[0].result;
          if(!ready) { calls++; await ctx.publish({lockSource,write}); }
          return {kind:'done'};
        }});
      assert.equal((await consumer.tick()).state,'retry');
      await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=clock_timestamp()-interval '1 second'");
      assert.equal((await consumer.tick()).state,'completed');
      assert.equal(calls,1); assert.equal((await queue.stats()).pending,0);
      consumer.stop(); await consumer.drain();
    });
    await queueActionCases(t,{pool,queue,clear,release,send});
  } finally { await pool.end(); }
});
