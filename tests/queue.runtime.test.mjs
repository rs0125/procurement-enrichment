import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDeliveryServices } from '../src/services/queue/deliveryServices.mjs';
import { createQueueRuntime } from '../src/services/queue/runtime.mjs';
import { createCronJobs } from '../src/services/cron/index.mjs';
import { sweepProximity } from '../src/services/cron/proximitySweep.mjs';
import { queueSettings } from '../src/lib/queue/settings.mjs';

test('cron and shadow keep inline processing; queue enqueues; API-only rejects processing in every mode',async()=>{
  for(const mode of ['cron','shadow','queue']) for(const role of ['api','worker']) {
    const calls=[];const settings=queueSettings({ENRICHMENT_DELIVERY_MODE:mode,ENRICHMENT_PROCESS_ROLE:role});
    const services={run:async(name,input)=>{calls.push(input.dryRun?'preview':'inline');return {status:input.dryRun?'DRY_RUN':'READY'};},stop(){},list:()=>[]};
    const queue={enqueue:async()=>{calls.push('queue');return {messageId:'1'};},ensurePending:async()=>{calls.push('repair');return {messageId:'2'};}};
    const facade=createDeliveryServices({services,queue,settings});
    assert.equal((await facade.run('webp',{imageId:1,dryRun:true})).status,'DRY_RUN');
    if(role==='api') {
      await assert.rejects(facade.run('webp',{imageId:1}),{statusCode:503});
      const jobs=createCronJobs({prisma:{},services:facade,queue,settings});
      for(const name of ['enrichment','webp','geocode']) assert.throws(()=>jobs[name].start(),{statusCode:503});
      assert.deepEqual(calls,['preview']);
    } else {
      assert.equal((await facade.run('webp',{imageId:1})).status,mode==='queue'?'QUEUED':'READY');
      assert.deepEqual(calls,['preview',mode==='queue'?'queue':'inline']);
      await facade.reconcile('webp',{imageId:1});
      assert.equal(calls.at(-1),mode==='queue'?'repair':'inline');
    }
  }
  assert.deepEqual(queueSettings(),{mode:'cron',role:'worker',canConsume:false});
});

test('queued proximity reconciliation never reserves a paid attempt',async()=>{
  let enqueued=0;
  const result=await sweepProximity({model:{bounded:async method=>method==='coverage'?[]:[{id:1,lat:12,lng:77}]},
    services:{deliveryMode:'queue',run:async()=>{enqueued++;return {status:'QUEUED'};}},
    runLog:new Proxy({},{get:()=>assert.fail('cron reserved an attempt')}),signal:new AbortController().signal});
  assert.equal(result.queued,1);assert.equal(enqueued,1);
});

test('API-only runtime never touches the queue; active worker drains and fences itself on leader loss',async()=>{
  let connections=0,stops=0,failures=0,releases=0;
  const leader=new EventEmitter();leader.query=async()=>({rows:[{held:true}]});leader.release=()=>releases++;
  const queue={pool:{connect:async()=>{connections++;return leader;}},assertReady:async()=>{},claim:async()=>null};
  const services={stop:()=>stops++};
  const api=createQueueRuntime({queue,prisma:{},services,settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue',ENRICHMENT_PROCESS_ROLE:'api'})});
  await api.start();await api.drain();assert.equal(connections,0);
  const worker=createQueueRuntime({queue,prisma:{},services,execute:fn=>fn(),settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'})});
  worker.onFailure(()=>failures++);await worker.start();
  leader.emit('error',new Error('fixture'));await worker.drain();
  assert.equal(failures,1);assert.equal(stops,1);assert.equal(releases,1);assert.equal(worker.status().healthy,false);
});

test('a competing worker and transaction-pooler configuration fail before consuming',async()=>{
  let claims=0,releases=0;
  const leader=new EventEmitter();leader.query=async()=>({rows:[{held:false}]});leader.release=()=>releases++;
  const queue={pool:{connect:async()=>leader},assertReady:async()=>{},claim:async()=>{claims++;}};
  const settings=queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'});
  const runtime=createQueueRuntime({queue,prisma:{},services:{},settings});
  await assert.rejects(runtime.start(),/already active/);assert.equal(releases,1);assert.equal(claims,0);
  queue.pool.options={connectionString:'postgresql://fixture:fixture@localhost:6543/fixture'};
  const pooled=createQueueRuntime({queue,prisma:{},services:{},settings});
  await assert.rejects(pooled.start(),/session-mode/);assert.equal(claims,0);
});

test('heartbeat detects a lost advisory lock even if the socket never emits an error',async()=>{
  let probe,failed=0,stops=0,released=0,connections=0;
  const leader=new EventEmitter();leader.release=()=>released++;
  leader.query=async sql=>({rows:[{pid:17,held:typeof sql==='string'}]});
  const queue={pool:{connect:async()=>{connections++;return leader;}},assertReady:async()=>{},claim:async()=>null};
  const runtime=createQueueRuntime({queue,prisma:{},services:{stop:()=>stops++},execute:fn=>fn(),
    settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'}),schedule:fn=>{probe=fn;return {};},unschedule:()=>{}});
  runtime.onFailure(()=>failed++);
  await Promise.all([runtime.start(),runtime.start()]);assert.equal(connections,1);
  probe();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(failed,1);assert.equal(stops,1);assert.equal(runtime.status().healthy,false);
  await runtime.drain();assert.equal(released,1);
});

test('stop during startup releases the acquired session without starting a consumer',async()=>{
  let allowLock,claimed=0,released=0;
  const leader=new EventEmitter();leader.release=()=>released++;
  leader.query=async sql=>sql.includes('pg_try_advisory_lock')?new Promise(resolve=>{allowLock=()=>resolve({rows:[{pid:17,held:true}]});}):{rows:[]};
  const queue={pool:{connect:async()=>leader},assertReady:async()=>{},claim:async()=>{claimed++;return null;}};
  const runtime=createQueueRuntime({queue,prisma:{},services:{},settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'})});
  const starting=runtime.start();await new Promise(resolve=>setImmediate(resolve));
  runtime.stop();allowLock();await starting;await runtime.drain();
  assert.equal(claimed,0);assert.equal(released,1);
});

test('only a queue leader records a bounded heartbeat; diagnostic-write failure does not stop processing',async t=>{
  t.mock.method(console,'error',()=>{});
  let writes=0,probe;
  const leader=new EventEmitter();leader.release=()=>{};leader.query=async()=>({rows:[{pid:17,held:true}]});
  const queue={pool:{connect:async()=>leader},assertReady:async()=>{},claim:async()=>null,
    recordHeartbeat:async(pid,state)=>{assert.equal(pid,17);assert.equal(state.enabled,true);writes++;throw Object.assign(new Error('SECRET'),{code:'57014'});}};
  const services={stop(){}};
  const api=createQueueRuntime({queue,prisma:{},services,settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue',ENRICHMENT_PROCESS_ROLE:'api'})});
  await api.start();await api.drain();assert.equal(writes,0);
  const runtime=createQueueRuntime({queue,prisma:{},services,execute:fn=>fn(),settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'}),
    schedule:fn=>{probe=fn;return {};},unschedule:()=>{}});
  await runtime.start();assert.equal(writes,1);probe();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,1);assert.equal(runtime.status().healthy,true);await runtime.drain();
});
