import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic,operation } from '../src/lib/runtime/diagnostics.mjs';
import { sweepImages } from '../src/services/cron/imageSweeps.mjs';
import { sweepProximity } from '../src/services/cron/proximitySweep.mjs';
import { createGeocodeRecentSweep } from '../src/services/cron/geocodeRecent.service.mjs';
import { createScheduledJob } from '../src/services/cron/scheduledJob.mjs';
import { createQueueConsumer } from '../src/services/queue/consumer.mjs';
import { queueSettings } from '../src/lib/queue/settings.mjs';
import { request } from '../src/lib/queue/contract.mjs';

const signal=()=>new AbortController().signal;
const pending={bounded:async(method,_stage,limit)=>method==='backlog'?{PENDING:2,RUNNING:1,FAILED:1}:[{id:7},{id:8}].slice(0,limit)};
test('queue image sweep reports successful bounded dispatch separately from outstanding domain work',async()=>{
  const result=await sweepImages({repository:pending,services:{deliveryMode:'queue',reconcile:async()=>({status:'QUEUED',messageId:'42'})},
    stage:'label',service:'image-label',limit:2,signal:signal()});
  assert.equal(result.status,'SUCCESS');assert.equal(result.dispatchStatus,'SUCCESS');
  assert.equal(result.processingStatus,'OUTSTANDING');assert.equal(result.queued,2);assert.equal(result.ready,0);
  assert.equal(result.hasMore,true);assert.equal(result.backlog.FAILED,1);
});
test('actual enqueue failure remains partial/failed and keeps safe subject/run correlation',async()=>{
  for(const allFail of [false,true]) {
    const result=await sweepImages({repository:pending,services:{deliveryMode:'queue',reconcile:async(_action,{imageId})=>{
      if(imageId===8 || allFail) throw Object.assign(new Error('postgresql://user:SECRET@private.example/db'),{code:'57014'});
      return {status:'QUEUED'};
    }},stage:'label',service:'image-label',limit:2,signal:signal(),jobId:'33',jobName:'sweep_warehouse_enrichment'});
    assert.equal(result.status,allFail?'FAILED':'PARTIAL');assert.equal(result.errors.at(-1).subjectId,'8');
    assert.equal(result.errors[0].jobId,'33');assert.equal(result.errors[0].code,'57014');assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});
test('proximity coverage and geocode page limits describe processing, not dispatch failure',async()=>{
  const services={deliveryMode:'queue',reconcile:async()=>({status:'QUEUED'})};
  const proximity=await sweepProximity({model:{bounded:async name=>name==='coverage'?[{category:'seaport',complete:false}]:[{id:1}]},
    services,runLog:{},signal:signal()});
  assert.equal(proximity.status,'SUCCESS');assert.equal(proximity.processingStatus,'OUTSTANDING');assert.deepEqual(proximity.skippedCategories,['seaport']);
  const geocode=await createGeocodeRecentSweep({repository:{pending:async()=>[{id:1},{id:2}]},services,limit:1}).work({signal:signal()});
  assert.equal(geocode.status,'SUCCESS');assert.equal(geocode.morePending,true);assert.equal(geocode.queued,1);assert.equal(geocode.succeeded,0);
});
test('diagnostics reject arbitrary error text/properties and preserve known nested database codes',async()=>{
  const error=Object.assign(new Error('SECRET'),{code:'P2010',meta:{code:'57014',database_error:'SECRET'},cause:{code:'ECONNRESET',message:'SECRET'},response:{status:429,data:'SECRET'},stack:'SECRET'});
  assert.deepEqual(diagnostic(error,{jobId:8n,action:'webp',url:'SECRET',messageId:'not-a-number'}),
    {jobId:'8',action:'webp',code:'P2010',databaseCode:'57014',httpStatus:429,causeCode:'ECONNRESET'});
  assert.equal(diagnostic({code:'SECRET',name:'SECRET',message:'SECRET'}).code,'unknown_error');
  await assert.rejects(operation({operation:'reconcile'},()=>{throw error;}),wrapped=>{
    assert.equal(diagnostic(wrapped,{jobId:'9'}).operation,'reconcile');
    assert.ok(!JSON.stringify(wrapped).includes('SECRET'));return true;
  });
});
test('failed scheduled operation persists safe cause with actual cron run ID',async t=>{
  t.mock.method(console,'error',()=>{});
  let callback,saved;
  const job=createScheduledJob({jobName:'sweep_warehouse_enrichment',budgetMs:1000,
    runLog:{tryStart:async()=>({id:99n}),finish:async(...args)=>{saved=args;}},schedule:fn=>{callback=fn;},
    work:async()=>operation({operation:'reconcile'},()=>{throw Object.assign(new Error('SECRET'),{code:'55P03'});})});
  await job.start();await callback();await job.drain();
  assert.equal(saved[1],'FAILED');assert.equal(saved[3].diagnostic.code,'55P03');
  assert.equal(saved[3].diagnostic.jobId,'99');assert.equal(saved[3].diagnostic.operation,'reconcile');
  assert.ok(!JSON.stringify(saved,(_k,v)=>typeof v==='bigint'?String(v):v).includes('SECRET'));
});
test('queue errors retain delivery identity and polling heartbeat excludes memory deferrals',async()=>{
  let time=100000,admit=true,claimed=false;
  const consumer=createQueueConsumer({settings:queueSettings({ENRICHMENT_DELIVERY_MODE:'queue'}),now:()=>time,
    execute:work=>admit?work():{status:'DEFERRED',reason:'memory_pressure'},
    queue:{claim:async()=>claimed?null:(claimed=true,{msg_id:'123',read_ct:2,message:request('webp',7)}),failDelivery:async()=>({kind:'retry'})},
    dispatch:async()=>{throw Object.assign(new Error('SECRET'),{code:'ETIMEDOUT'});}});
  const result=await consumer.tick();assert.equal(result.diagnostic.messageId,'123');assert.equal(result.diagnostic.subjectId,'7');
  assert.equal(result.diagnostic.readCount,2);assert.equal(result.diagnostic.code,'ETIMEDOUT');
  const firstPoll=consumer.status().lastPollAt;time+=600000;admit=false;await consumer.tick();
  assert.equal(consumer.status().lastPollAt,firstPoll);assert.equal(consumer.status().lastCompletedAt,null);
  admit=true;await consumer.tick();assert.notEqual(consumer.status().lastPollAt,firstPoll);
  assert.ok(!JSON.stringify(consumer.status()).includes('SECRET'));
});
