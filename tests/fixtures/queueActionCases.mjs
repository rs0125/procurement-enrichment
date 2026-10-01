import assert from 'node:assert/strict';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEnrichmentServices } from '../../src/services/enrichment/index.mjs';
import { createDeliveryServices } from '../../src/services/queue/deliveryServices.mjs';
import { createQueueDispatcher } from '../../src/services/queue/dispatcher.mjs';
import { createWarehouseRefresh } from '../../src/services/queue/refresh.mjs';
import { createQueueConsumer } from '../../src/services/queue/consumer.mjs';
import { QueueActionContext } from '../../src/models/queue/actionContext.mjs';
import { ImageRepository } from '../../src/models/images/repository.mjs';
import { request } from '../../src/lib/queue/contract.mjs';
import categories from '../../src/lib/proximity/proximityCategories.cjs';

export async function queueActionCases(t,{pool,queue,clear,release,send}) {
  const prisma=new PrismaClient({adapter:new PrismaPg(pool)});
  const previousToken=process.env.MAPBOX_ACCESS_TOKEN;process.env.MAPBOX_ACCESS_TOKEN='local-fixture';
  const imageUrl='https://images.example/fixture.jpg';
  const row=async()=>(await pool.query('SELECT * FROM labeled_warehouse_images WHERE id=100')).rows[0];
  const reset=async()=>{
    await clear();
    await pool.query('TRUNCATE "WarehouseData","Warehouse","GeocodeAttempt",labeled_warehouse_images,"CronRunLog",warehouse_proximity,osm_ingest_tile');
    await pool.query('INSERT INTO "Warehouse"(id,media,photos,"googleLocation") VALUES(100,$1,$2,$3)',[JSON.stringify({images:[imageUrl]}),JSON.stringify([imageUrl]),'https://maps.example/source']);
    await pool.query('INSERT INTO labeled_warehouse_images(id,"warehouseId","imageUrl") VALUES(100,100,$1)',[imageUrl]);
  };
  function fixture(overrides={}) {
    const calls={};const count=name=>{calls[name]=(calls[name]??0)+1;};
    const store={publicBase:'https://images.example',bucket:'fixture',url:key=>'https://images.example/'+key,
      head:async()=>({bytes:123,modifiedAt:new Date()}),put:async()=>assert.fail('unexpected upload')};
    const providers={imageConfigured:()=>true,storageConfigured:()=>true,getStore:()=>store,invalidate:async()=>{},
      classify:async()=>{count('label');return {classification:'DOCUMENT',description:'A layout',confidence:.9};},
      classifyDocument:async()=>{count('document');return {documentKind:'LAYOUT'};},
      assess:async()=>{count('website');return {decision:'BLOCK',qualityTier:'T2',assessment:{model:'fixture'}};},
      extract:async()=>{count('geocode');return {lat:12.9,lng:77.5,via:'url_@'};},warmUp:async()=>{},
      temporary:async fn=>fn('/fixture/input','/fixture/output'),download:async()=>{count('download');return {bytes:1000,hash:'abc'};},
      decode:async()=>({metadata:{format:'jpeg',width:640,height:480}}),
      expectedRegions:Object.fromEntries(categories.CATEGORIES.map(c=>[c.key,0])),
      computer:{compute:async(w,needed)=>{count('proximity');return needed.map(c=>({category:c.key,status:'NONE_IN_RANGE',computedFromLat:w.lat,computedFromLng:w.lng}));}},...overrides};
    const services=createEnrichmentServices({prisma,providers});
    const dispatch=createQueueDispatcher({prisma,services,pause:async()=>{},refresh:createWarehouseRefresh({queue})});
    const run=async(action,id=100,enqueue=true)=>{
      if(enqueue) await queue.enqueue(request(action,id));
      const specific=Object.create(queue);specific.claim=(_action,lane)=>queue.claim(action,lane);
      const consumer=createQueueConsumer({queue:specific,dispatch,settings:{mode:'queue',role:'worker'},execute:fn=>fn()});
      try {return await consumer.tick();} finally {consumer.stop();await consumer.drain();}
    };
    return {calls,run,dispatch};
  }
  try {
    await t.test('a new explicit request survives acknowledgement of an already-running job',async()=>{
      await reset();const old=await send('jpeg',100);
      const facade=createDeliveryServices({queue,services:{},settings:{mode:'queue',role:'worker'}});
      const accepted=await facade.run('jpeg',{imageId:100});
      await queue.finish(old);
      assert.notEqual(accepted.messageId,old.msg_id);
      assert.equal((await queue.stats()).pending,1);
    });
    await t.test('proximity waits through a recoverable geocode cooldown instead of dead-lettering',async()=>{
      await reset();await pool.query('INSERT INTO "GeocodeAttempt"("warehouseId","attemptCount","lastAttemptAt") VALUES(100,1,now())');
      const f=fixture();assert.equal((await f.run('proximity')).state,'deferred');
      assert.equal((await queue.stats()).dead,0);
      assert.equal((await pool.query("SELECT 1 FROM pgmq.q_enrichment_jobs WHERE message->>'action'='geocode'")).rowCount,1);
    });
    await t.test('sub-tolerance coordinate jitter cannot bypass the proximity cooldown',async()=>{
      await reset();await pool.query('INSERT INTO "WarehouseData"("warehouseId",latitude,longitude) VALUES(100,12,77)');
      let calls=0;const f=fixture({computer:{compute:async()=>{calls++;throw new Error('fixture provider failure');}}});
      await f.run('proximity');assert.equal(calls,1);
      await pool.query('UPDATE "WarehouseData" SET latitude=latitude+0.0000000005');
      await f.run('proximity');assert.equal(calls,1);
    });
    await t.test('refresh rolls back registration and reports stale when visibility expires inside its transaction',async()=>{
      await reset();await pool.query('DELETE FROM labeled_warehouse_images');
      await pool.query(`CREATE FUNCTION fixture_slow_register() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$;
        CREATE TRIGGER fixture_slow_register BEFORE INSERT ON labeled_warehouse_images FOR EACH ROW EXECUTE FUNCTION fixture_slow_register()`);
      try {
        const delivery=await send('refresh-warehouse',100);
        await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=clock_timestamp()+interval '150 milliseconds' WHERE msg_id=$1",[delivery.msg_id]);
        const result=await fixture().dispatch(request('refresh-warehouse',100),{receipt:delivery,signal:new AbortController().signal});
        assert.equal(result.state,'stale');
        assert.equal((await pool.query('SELECT * FROM labeled_warehouse_images')).rowCount,0);
        assert.equal((await queue.stats()).archived,0);
      } finally {await pool.query('DROP TRIGGER fixture_slow_register ON labeled_warehouse_images; DROP FUNCTION fixture_slow_register()');}
    });
    await t.test('all seven real handlers persist results, preserve originals and skip paid redelivery',async()=>{
      await reset();const f=fixture();
      for(const action of ['image-label','document-kind','website-approval','webp','jpeg','geocode','proximity']) assert.equal((await f.run(action)).state,'completed',action);
      const saved=await row();assert.equal(saved.documentKind,'LAYOUT');assert.equal(saved.websiteDecision,'BLOCK');
      assert.equal(saved.jpegUrl,imageUrl);assert.equal(saved.webpStatus,'READY');
      assert.equal((await pool.query('SELECT media FROM "Warehouse" WHERE id=100')).rows[0].media.images[0],imageUrl);
      const before={...f.calls};
      for(const action of ['image-label','document-kind','website-approval','webp','jpeg','geocode','proximity']) await f.run(action);
      assert.deepEqual(f.calls,before);
      assert.equal((await pool.query('SELECT "attemptCount" FROM "GeocodeAttempt" WHERE "warehouseId"=100')).rows[0].attemptCount,1);
    });
    await t.test('removed media and superseded queue ownership refuse label publication',async()=>{
      for(const change of ['media','receipt']) {
        await reset();const f=fixture({classify:async()=>{
          if(change==='media') await pool.query(`UPDATE "Warehouse" SET media='{"images":[]}' WHERE id=100`);
          else {await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=now()-interval '1 second'");await queue.claim('image-label','live');}
          return {classification:'OUTDOOR',description:'fixture',confidence:.9};
        }});
        await f.run('image-label');assert.equal((await row()).classification,null);
      }
    });
    await t.test('manual website override arriving during assessment is preserved',async()=>{
      await reset();const f=fixture({assess:async()=>{
        await pool.query(`UPDATE labeled_warehouse_images SET "websiteOverride"='{"decision":"ALLOW"}' WHERE id=100`);
        return {decision:'BLOCK',qualityTier:'T2',assessment:{}};
      }});
      await f.run('website-approval');assert.equal((await row()).websiteDecision,null);assert.equal((await row()).websiteOverride.decision,'ALLOW');
    });
    await t.test('geocode reserves before external work; a changed Maps URL fences publication',async()=>{
      await reset();const f=fixture({extract:async()=>{
        assert.equal((await pool.query('SELECT "attemptCount" FROM "GeocodeAttempt" WHERE "warehouseId"=100')).rows[0].attemptCount,1);
        await pool.query('UPDATE "Warehouse" SET "googleLocation"=$1 WHERE id=100',['https://maps.example/changed']);
        return {lat:12,lng:77,via:'url_@'};
      }});
      await f.run('geocode');assert.equal((await pool.query('SELECT * FROM "WarehouseData"')).rowCount,0);
    });
    await t.test('JPEG retries have a durable five-attempt limit and cooldown, with no work while waiting',async()=>{
      await reset();await pool.query(`UPDATE labeled_warehouse_images SET classification='INDOOR',"labelStatus"='READY'`);
      let calls=0;const f=fixture({download:async()=>{calls++;throw new Error('fixture');}});
      for(let i=1;i<=5;i++) {
        await f.run('jpeg');assert.equal(calls,i);
        await f.run('jpeg');assert.equal(calls,i);
        await pool.query(`UPDATE "CronRunLog" SET metadata=metadata||jsonb_build_object('retryAt',now()-interval '1 day')`);
      }
      assert.equal((await f.run('jpeg')).state,'terminal');assert.equal(calls,5);assert.equal((await row()).jpegStatus,'FAILED');
    });
    await t.test('an expired final image attempt becomes FAILED without another provider call',async()=>{
      await reset();await pool.query(`UPDATE labeled_warehouse_images SET "labelStatus"='RUNNING',"labelAttempts"=5,"labelLeaseUntil"=now()-interval '1 minute'`);
      const f=fixture();assert.equal((await f.run('image-label')).state,'terminal');
      assert.equal((await row()).labelStatus,'FAILED');assert.equal(f.calls.label,undefined);
    });
    await t.test('an abandoned JPEG attempt still prevents concurrent encoding until its lease expires',async()=>{
      await reset();await pool.query(`UPDATE labeled_warehouse_images SET classification='INDOOR',"labelStatus"='READY'`);
      const delivery=await send('jpeg',100),source=await new ImageRepository(prisma).getActive(100);
      const ctx=new QueueActionContext({prisma,action:'jpeg',source,delivery:{receipt:delivery,signal:new AbortController().signal}});
      assert.equal(await ctx.reserve(),null);await release(delivery.msg_id);
      const f=fixture();assert.equal((await f.run('jpeg')).state,'deferred');assert.equal(f.calls.download,undefined);
    });
    await t.test('coordinate edits during routing and classification edits during JPEG work refuse stale results',async()=>{
      await reset();await pool.query('INSERT INTO "WarehouseData"("warehouseId",latitude,longitude) VALUES(100,12,77)');
      const f=fixture({computer:{compute:async(w,needed)=>{
        await pool.query('UPDATE "WarehouseData" SET latitude=13');return needed.map(c=>({category:c.key,status:'NONE_IN_RANGE',computedFromLat:w.lat,computedFromLng:w.lng}));
      }}});await f.run('proximity');assert.equal((await pool.query('SELECT * FROM warehouse_proximity')).rowCount,0);
      await pool.query(`UPDATE labeled_warehouse_images SET classification='INDOOR',"labelStatus"='READY'`);
      const g=fixture({download:async()=>{await pool.query(`UPDATE labeled_warehouse_images SET classification='DOCUMENT'`);return {bytes:1000,hash:'abc'};}});
      await g.run('jpeg');assert.equal((await row()).jpegUrl,null);
    });
    await t.test('large warehouse fan-out pages atomically and reaches every image',async()=>{
      await reset();await pool.query('DELETE FROM labeled_warehouse_images');
      const urls=Array.from({length:27},(_,i)=>`https://images.example/${i}.jpg`);
      await pool.query('UPDATE "Warehouse" SET media=$1,"googleLocation"=NULL WHERE id=100',[JSON.stringify({images:urls})]);
      const f=fixture();let result=await f.run('refresh-warehouse');let pages=1;
      while(result.state==='deferred' && pages<10) {await pool.query("UPDATE pgmq.q_enrichment_jobs SET vt=now()-interval '1 second' WHERE message->>'action'='refresh-warehouse'");result=await f.run('refresh-warehouse',100,false);pages++;}
      assert.equal(pages,3);assert.equal(result.state,'completed');assert.equal((await queue.stats()).pending,108);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM labeled_warehouse_images')).rows[0].n,27);
    });
  } finally {
    await prisma.$disconnect();
    if(previousToken===undefined) delete process.env.MAPBOX_ACCESS_TOKEN;else process.env.MAPBOX_ACCESS_TOKEN=previousToken;
  }
}
