import test from 'node:test';
import assert from 'node:assert/strict';
import { request, message, receipt, disposition, followups } from '../src/lib/queue/contract.mjs';
import { queueSettings } from '../src/lib/queue/settings.mjs';
import { createQueueConsumer } from '../src/services/queue/consumer.mjs';
import { createQueuePlanner, imageReadiness } from '../src/services/queue/planner.mjs';
import { runQueueCommand } from '../src/lib/queue/cli.mjs';
import { createExecutor } from '../src/lib/runtime/executor.mjs';

const worker = queueSettings({ENRICHMENT_DELIVERY_MODE:'queue', ENRICHMENT_PROCESS_ROLE:'worker'});
const event = (id='1') => ({msg_id:id,read_ct:1,message:request('webp',123)});
const admitted = () => createExecutor({available:async()=>1024**3, rss:()=>0});
function fixture(deliveries=[event()]) {
  const calls=[];
  const queue={
    assertReady:async()=>calls.push(['ready']),
    claim:async(action,lane)=>{calls.push(['claim',action,lane]);return deliveries.shift() ?? null;},
    finish:async(...args)=>{calls.push(['finish',...args]);return true;},
    defer:async(...args)=>{calls.push(['defer',...args]);return true;},
    reject:async(...args)=>{calls.push(['reject',...args]);return true;},
    failDelivery:async(...args)=>{calls.push(['failure',...args]);return {kind:'retry'};},
    withReceipt:async()=>assert.fail('Unexpected publication')
  };
  return {queue,calls};
}

test('queue messages reject arbitrary payloads, invalid subjects and precision loss',()=>{
  assert.deepEqual(request('webp',2147483647),{v:1,action:'webp',subjectId:'2147483647',lane:'live'});
  for(const id of [0,-1,1.2,2147483648,'001','1e3',true]) assert.throws(()=>request('webp',id));
  for(const patch of [{url:'https://example.invalid/private'}, {v:2}, {subjectId:1}, {lane:'urgent'}, {action:'sql'}]) {
    assert.throws(()=>message({...request('webp',1),...patch}));
  }
  assert.equal(receipt({msg_id:'9223372036854775807',read_ct:1}).msg_id,'9223372036854775807');
  assert.throws(()=>receipt({msg_id:9223372036854775807,read_ct:1}));
  assert.throws(()=>receipt({msg_id:'1',read_ct:0}));
  assert.throws(()=>disposition({status:'READY'}));
  assert.throws(()=>disposition({kind:'defer',delaySeconds:0,reason:'busy'}));
  assert.throws(()=>followups(Array(51).fill(request('webp',1))));
});

test('cron, shadow and API-only roles cannot claim or dispatch',async()=>{
  for(const mode of ['cron','shadow','queue']) for(const role of ['api','worker']) {
    if(mode==='queue' && role==='worker') continue;
    const f=fixture(), consumer=createQueueConsumer({...f, settings:queueSettings({ENRICHMENT_DELIVERY_MODE:mode,ENRICHMENT_PROCESS_ROLE:role})});
    assert.equal(await consumer.start(),null);
    assert.equal((await consumer.tick()).state,'disabled');assert.deepEqual(f.calls,[]);
  }
  assert.equal(queueSettings().canConsume,false);
  assert.throws(()=>queueSettings({ENRICHMENT_DELIVERY_MODE:'true'}));
  assert.throws(()=>createQueueConsumer({settings:worker,queue:{}}),/adapter required/);
});

test('memory admission and busy executor defer before touching the queue',async()=>{
  const f=fixture();let providers=0;
  const consumer=createQueueConsumer({...f,settings:worker,dispatch:async()=>{providers++;},
    execute:createExecutor({available:async()=>1,rss:()=>0})});
  assert.equal((await consumer.tick()).reason,'memory_pressure');
  assert.deepEqual(f.calls,[]);assert.equal(providers,0);
});
test('RSS recovery stops before claiming a queue receipt or consuming an attempt',async()=>{
  const f=fixture();let restarts=0;
  const consumer=createQueueConsumer({...f,settings:worker,dispatch:()=>assert.fail('provider called'),
    execute:createExecutor({available:async()=>1024**3,rss:()=>390*1024**2,onMemoryLimit:()=>{restarts++;}})});
  assert.equal((await consumer.tick()).reason,'memory_pressure');
  assert.equal((await consumer.tick()).reason,'memory_pressure');
  assert.deepEqual(f.calls,[]);assert.equal(restarts,1);
});

test('consumer admits once, never overlaps or prefetches, and atomically sends dependents',async()=>{
  const f=fixture([event('1'),event('2')]);let release;
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:()=>new Promise(resolve=>{release=resolve;})});
  const pending=consumer.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await consumer.tick()).state,'busy');
  assert.equal(f.calls.filter(c=>c[0]==='claim').length,1);
  release({kind:'done',followups:[request('document-kind',123)]});
  assert.equal((await pending).state,'completed');
  assert.equal(f.calls.find(c=>c[0]==='finish')[2][0].action,'document-kind');
  consumer.stop();await consumer.drain();
});

test('one in five preferred dispatches serves backfill and actions rotate',async()=>{
  const f=fixture(Array.from({length:10},(_,i)=>event(String(i+1))));
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:async()=>({kind:'done'})});
  for(let i=0;i<10;i++) await consumer.tick();
  const claims=f.calls.filter(c=>c[0]==='claim');
  assert.equal(claims[4][2],'backfill');assert.equal(claims[9][2],'backfill');
  assert.equal(new Set(claims.slice(0,8).map(c=>c[1])).size,8);
});

test('malformed messages are dead-lettered without invoking an action',async()=>{
  const f=fixture([{...event(),message:{...event().message,v:2}}]);
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:()=>assert.fail('action called')});
  assert.equal((await consumer.tick()).state,'terminal');
  assert.equal(f.calls.find(c=>c[0]==='reject')[2],'invalid_message');
});

test('retry/dependency/configuration deferrals do not increment operational failures',async()=>{
  for(const kind of ['retry','defer','configuration']) {
    const f=fixture();
    const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:async()=>{
      if(kind==='configuration') {const error=new Error('synthetic-secret');error.statusCode=503;throw error;}
      return {kind,delaySeconds:300,reason:'waiting_for_domain_retry'};
    }});
    assert.equal((await consumer.tick()).state,'deferred');
    assert.equal(f.calls.filter(c=>c[0]==='failure').length,0);
    assert.equal(f.calls.filter(c=>c[0]==='finish').length,0);
  }
});

test('unknown action result is not acknowledged and uses bounded delivery failure policy',async()=>{
  const f=fixture();
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:async()=>({status:'READY'})});
  assert.equal((await consumer.tick()).state,'retry');
  assert.equal(f.calls.filter(c=>c[0]==='failure').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='finish').length,0);
});

test('stop during work drains the action and leaves its uncertain receipt unacknowledged',async()=>{
  const f=fixture();let release,context;
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:(_input,ctx)=>{
    context=ctx;return new Promise(resolve=>{release=resolve;});
  }});
  const pending=consumer.tick();await new Promise(resolve=>setImmediate(resolve));
  consumer.stop();assert.equal(context.signal.aborted,true);
  let drained=false;const draining=consumer.drain().then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
  release({kind:'done'});assert.equal((await pending).state,'interrupted');await draining;
  assert.equal(f.calls.some(c=>['finish','defer','failure'].includes(c[0])),false);
  assert.equal((await consumer.tick()).state,'stopped');
});

test('deadline aborts cooperative work without acknowledging its result',async()=>{
  const f=fixture();
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),actionTimeoutMs:5,
    dispatch:async(_input,{signal})=>{await new Promise(resolve=>setTimeout(resolve,15));assert.equal(signal.aborted,true);return {kind:'done'};}});
  assert.equal((await consumer.tick()).state,'interrupted');
  assert.equal(f.calls.some(c=>c[0]==='finish'),false);
});

test('idle polling backs off; stop interrupts the wait; reporting contains no payload',async()=>{
  const f=fixture([]), waits=[], reports=[];let consumer;
  consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:async()=>assert.fail('no message'),
    random:()=>0,report:result=>reports.push(result),pause:async ms=>{waits.push(ms);if(waits.length===5)consumer.stop();}});
  await consumer.start();await consumer.drain();
  assert.deepEqual(waits,[5000,10000,20000,30000,30000]);
  assert.ok(reports.every(r=>Object.keys(r).length===1 && r.state==='idle'));
});

test('image readiness preserves privacy results, retry caps, dependencies and live final attempts',()=>{
  const pending={id:1,labelStatus:'PENDING',labelAttempts:0,websiteStatus:'READY',websiteDecision:'BLOCK'};
  assert.equal(imageReadiness('website-approval',pending).state,'done');
  assert.equal(imageReadiness('website-approval',{...pending,websiteStatus:'FAILED',hasWebsiteOverride:true}).state,'done');
  assert.equal(imageReadiness('document-kind',pending).reason,'label_required');
  assert.equal(imageReadiness('document-kind',{...pending,classification:'INDOOR'}).state,'done');
  assert.equal(imageReadiness('image-label',{...pending,labelAttempts:5}).state,'terminal');
  assert.equal(imageReadiness('image-label',{...pending,labelStatus:'UNSUPPORTED'}).state,'terminal');
  assert.equal(imageReadiness('image-label',{...pending,labelNextAttemptAt:new Date(Date.now()+60000)}).state,'waiting');
  assert.equal(imageReadiness('image-label',{...pending,labelAttempts:5,labelStatus:'RUNNING',labelLeaseUntil:new Date(Date.now()+60000)}).reason,'stage_claimed');
  assert.equal(imageReadiness('jpeg',{...pending,labelStatus:'READY',classification:'INDOOR'}).state,'eligible');
});

test('planner deduplicates shared image IDs, preserves unregistered work and refuses oversized input',async()=>{
  const row={id:7,labelStatus:'PENDING',websiteStatus:'PENDING',webpStatus:'PENDING'};
  const source={warehouse:{id:1,geocodeEligible:true},images:[row,row,{id:null}],oversized:false};
  const planner=createQueuePlanner({sources:{snapshot:async()=>source}});
  const plan=await planner.preview('1');
  assert.equal(plan.jobs.length,4);assert.equal(plan.needsRegistration,true);
  assert.equal(plan.jobs.some(j=>j.action==='jpeg'),false);
  source.oversized=true;
  assert.equal((await planner.preview('1')).status,'BLOCKED');
  assert.deepEqual((await planner.preview('1')).jobs,[]);
});

test('CLI dry run validates without queries; doctor is read-only; enqueue never starts a worker',async()=>{
  const f=fixture();let calls=0;
  const deps={queue:{doctor:async()=>({ready:false}),assertReady:async()=>{calls++;},enqueue:async()=>{calls++;return {messageId:'123'};}},planner:{preview:async id=>({warehouseId:id})}};
  assert.equal((await runQueueCommand(['enqueue','--action=webp','--id=7','--dry-run'],deps)).status,'DRY_RUN');
  assert.equal(calls,0);assert.equal((await runQueueCommand(['doctor'],deps)).ready,false);
  assert.equal((await runQueueCommand(['enqueue','--action=webp','--id=7'],deps)).processingEnabledByThisCommand,false);
  assert.equal(calls,2);
  for(const args of [['enqueue','--action=webp','--id=7','--url=https://private.invalid'],['plan','--warehouse-id=1','--warehouse-id=2']]) {
    await assert.rejects(runQueueCommand(args,deps));
  }
});

test('repeated polling failures make health fail and a successful poll restores it',async()=>{
  let polls=0;const healthy=[];
  const f=fixture();f.queue.claim=async()=>{if(polls<3) throw new Error('fixture queue permission failure');return null;};
  const consumer=createQueueConsumer({...f,settings:worker,execute:admitted(),dispatch:async()=>({kind:'done'}),
    pause:async()=>{healthy.push(consumer.status().healthy);if(++polls===4) consumer.stop();}});
  await consumer.start();await consumer.drain();
  assert.deepEqual(healthy,[true,true,false,true]);
});

test('trial configuration fails closed and separates warehouse and image ID namespaces',async()=>{
  const make=value=>queueSettings({ENRICHMENT_DELIVERY_MODE:'queue',ENRICHMENT_QUEUE_TRIAL_SUBJECTS:JSON.stringify(value)});
  for(const value of [null,{},[],{warehouseIds:[],imageIds:[]},{warehouseIds:[0],imageIds:[1]},
    {warehouseIds:[1],imageIds:[2],extra:true},{warehouseIds:[1],imageIds:Array(101).fill(2)}]) assert.throws(()=>make(value));
  assert.throws(()=>queueSettings({ENRICHMENT_QUEUE_TRIAL_SUBJECTS:''}));
  const settings=make({warehouseIds:[7],imageIds:[123]});
  const deliveries=[request('webp',7),request('refresh-warehouse',123),request('refresh-warehouse',7),request('webp',123)]
    .map((message,i)=>({msg_id:String(i+1),read_ct:1,message}));
  const f=fixture(deliveries),seen=[];
  const consumer=createQueueConsumer({...f,settings,execute:admitted(),dispatch:async input=>{seen.push(input);return {kind:'done'};}});
  assert.equal((await consumer.tick()).state,'trial_deferred');
  assert.equal((await consumer.tick()).state,'trial_deferred');
  assert.equal((await consumer.tick()).state,'completed');
  assert.equal((await consumer.tick()).state,'completed');
  assert.deepEqual(seen.map(x=>[x.action,x.subjectId]),[['refresh-warehouse','7'],['webp','123']]);
  assert.equal(f.calls.filter(c=>c[0]==='defer').length,2);
  assert.equal(f.calls.filter(c=>['reject','failure'].includes(c[0])).length,0);
  assert.equal(consumer.status().restrictedTrial,true);assert.equal(consumer.status().trialDeferred,2);
  consumer.stop();await consumer.drain();
});
