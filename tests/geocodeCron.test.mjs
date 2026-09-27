import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGeocodeRecentSweep } from '../src/services/cron/geocodeRecent.service.mjs';
import { createScheduledJob } from '../src/services/cron/scheduledJob.mjs';
import { createGeocodeService } from '../src/services/enrichment/geocode.mjs';

test('nightly geocoding uses bounded selection and defers excess candidates',async()=>{
  const calls=[];
  const sweep=createGeocodeRecentSweep({limit:2,repository:{pending:async limit=>{assert.equal(limit,3);return [{id:1},{id:2},{id:3}];}},
    services:{run:async(name,input)=>{calls.push([name,input.warehouseId]);return {status:'READY'};}},pause:async()=>{}});
  assert.deepEqual(await sweep.preview(),{status:'DRY_RUN',scope:'recent-7d',candidates:2,limit:2,morePending:true});
  assert.equal(calls.length,0);
  const result=await sweep.work({signal:new AbortController().signal});
  assert.equal(result.status,'PARTIAL');assert.equal(result.succeeded,2);assert.equal(result.morePending,true);
  assert.deepEqual(calls,[['geocode',1],['geocode',2]]);
});

test('nightly shutdown interrupts pacing and does not consume the next candidate',async()=>{
  const controller=new AbortController();let calls=0;
  const sweep=createGeocodeRecentSweep({repository:{pending:async()=>[{id:1},{id:2}]},
    services:{run:async()=>{calls++;return {status:'READY'};}},
    pause:async(ms,value,options)=>{controller.abort();return delay(ms,value,options);}});
  const result=await sweep.work({signal:controller.signal});
  assert.equal(calls,1);assert.equal(result.deferred,1);assert.equal(result.status,'PARTIAL');
});

test('nightly duplicate triggers share one persisted run and drain waits for it',async()=>{
  const rows=[],scheduled=[];let calls=0;
  const runLog={tryStart:async name=>{
    if(rows.some(row=>row.status==='RUNNING')) return null;
    const row={id:1n,jobName:name,status:'RUNNING',ranAt:new Date()};rows.push(row);return row;
  },recent:async()=>rows[0],finish:async(_id,status,_duration,metadata)=>Object.assign(rows[0],{status,metadata})};
  const sweep=createGeocodeRecentSweep({repository:{pending:async()=>[{id:1}]},services:{run:async()=>{calls++;return {status:'READY'};}}});
  const options={...sweep,jobName:'geocode-recent',budgetMs:1000,runLog,schedule:fn=>scheduled.push(fn)};
  const jobs=[createScheduledJob(options),createScheduledJob(options)];
  const results=await Promise.all(jobs.map(job=>job.start()));
  assert.deepEqual(results.map(r=>r.status),['accepted','already_running']);
  let drained=false;const draining=jobs[0].drain().then(()=>drained=true);
  await delay(0);assert.equal(drained,false);await scheduled[0]();await draining;
  assert.equal(calls,1);assert.equal(rows[0].metadata.succeeded,1);assert.equal(rows[0].status,'SUCCESS');
});

test('geocoding cancellation records neither coordinates nor a failed attempt',async()=>{
  const controller=new AbortController();
  const action=createGeocodeService({repository:{get:async()=>({googleLocation:'x'}),
    fail:()=>assert.fail('counted cancelled lookup'),publish:()=>assert.fail('published cancelled lookup')},
    warmUp:async()=>{},extract:async()=>{controller.abort();throw new Error('aborted');}});
  await assert.rejects(action({warehouseId:1,signal:controller.signal}));
});

test('geocoding rejects non-finite and out-of-range coordinates before publication',async()=>{
  for(const [lat,lng] of [[NaN,77],[Infinity,77],[91,77],[12,-181],[null,null]]) {
    let attempts=0;
    const action=createGeocodeService({repository:{get:async()=>({googleLocation:'x'}),
      fail:async()=>{attempts++;return true;},publish:()=>assert.fail('published invalid coordinates')},
      warmUp:async()=>{},extract:async()=>({lat,lng,via:'url_@'})});
    assert.equal((await action({warehouseId:1})).status,'FAILED');assert.equal(attempts,1);
  }
});
