import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { ImageRepository } from '../src/models/images/repository.mjs';
import { geocodeRepository } from '../src/models/geocode/singleRepository.mjs';
import ProximityRepository from '../src/models/proximity/repository.mjs';
import jpeg from '../src/lib/images/jpegPolicy.cjs';
import { createEnrichmentServices } from '../src/services/enrichment/index.mjs';

const url=process.env.ENRICHER_TEST_DATABASE_URL;
test('database claims and publications preserve shared production contracts',{skip:!url},async t=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));assert.equal(parsed.pathname,'/enricher_test');
  const pool=new pg.Pool({connectionString:url,max:4});
  const prisma=new PrismaClient({adapter:new PrismaPg(pool)});
  const repository=new ImageRepository(prisma),base='https://images.example';
  const stages=['label','document','website','webp'];
  try {
    await pool.query(`DROP TABLE IF EXISTS warehouse_proximity,osm_ingest_tile,"OsmIngestTile","GeocodeAttempt","CronRunLog",labeled_warehouse_images,"WarehouseData","Warehouse" CASCADE;
      DROP TYPE IF EXISTS "ImageClass","DocumentKind";
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE TYPE "ImageClass" AS ENUM ('INDOOR','OUTDOOR','DOCUMENT','UNKNOWN');
      CREATE TYPE "DocumentKind" AS ENUM ('LAYOUT','PAPERWORK','OTHER_DOCUMENT','NOT_A_DOCUMENT');
      CREATE TABLE "Warehouse" (id int PRIMARY KEY,media jsonb,photos text,"photosWebp" text,visibility boolean DEFAULT true,"googleLocation" text);
      CREATE TABLE "WarehouseData" (id serial PRIMARY KEY,"warehouseId" int UNIQUE REFERENCES "Warehouse"(id),latitude double precision,longitude double precision,
        geog geography(Point,4326) GENERATED ALWAYS AS (CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN ST_SetSRID(ST_MakePoint(longitude,latitude),4326)::geography END) STORED);
      CREATE TABLE "GeocodeAttempt" (id serial PRIMARY KEY,"warehouseId" int UNIQUE,"attemptCount" int DEFAULT 0,"lastAttemptAt" timestamp DEFAULT now(),"lastVia" text,"lastError" text,"succeededAt" timestamp);
      CREATE TABLE "CronRunLog" (id bigserial PRIMARY KEY,"jobName" text,"ranAt" timestamp DEFAULT now(),status text,"durationMs" int,metadata jsonb,notes text);
      CREATE TABLE labeled_warehouse_images (id serial PRIMARY KEY,"warehouseId" int,"imageUrl" text UNIQUE,classification "ImageClass",description text,confidence double precision,model text,"labelledAt" timestamp,
        "documentKind" "DocumentKind","unreferencedAt" timestamptz,
        "storageBucket" text,"originalObjectKey" text,"webpUrl" text,"webpObjectKey" text,"webpBytes" bigint,"webpAt" timestamptz,"webpCheckedAt" timestamptz,"webpVersion" text,
        "jpegUrl" text,"jpegBytes" bigint,"jpegAt" timestamptz,"jpegVersion" text,"jpegStatus" text DEFAULT 'PENDING',"jpegError" text,
        "websiteDecision" text,"websiteQualityTier" text,"websiteAssessment" jsonb,"websiteAssessedAt" timestamptz,"manualSentinel" text DEFAULT 'preserve-me',
        ${stages.map(s=>`"${s}Status" text DEFAULT 'PENDING',"${s}Attempts" int DEFAULT 0,"${s}ClaimToken" text,"${s}LeaseUntil" timestamptz,"${s}NextAttemptAt" timestamptz,"${s}Error" text`).join(',')});
      CREATE TABLE osm_ingest_tile (id serial PRIMARY KEY,category text,status text);
      CREATE TABLE warehouse_proximity (id serial PRIMARY KEY,"warehouseId" int REFERENCES "Warehouse"(id),category text,status text DEFAULT 'OK',"landmarkName" text,"poiSource" text,"poiId" text,"poiLat" double precision,"poiLng" double precision,"roadKm" double precision,"driveMinutes" int,provider text,profile text,candidates int,warnings text[] DEFAULT '{}',attempts int DEFAULT 1,"lastError" text,"computedAt" timestamp DEFAULT now(),"computedFromLat" double precision,"computedFromLng" double precision,"poiWatermark" timestamp,UNIQUE("warehouseId",category));`);
    await pool.query(await readFile(new URL('./imageUrls.sql',import.meta.url),'utf8'));
    for(let id=1;id<=5;id++) {
      const image=`${base}/${id}.jpg`;
      await pool.query('INSERT INTO "Warehouse" (id,media,photos,"googleLocation") VALUES ($1,$2,$3,$4)',[id,JSON.stringify({images:[image]}),JSON.stringify([image]),'https://maps.google.com/?q=12,77']);
      await pool.query('INSERT INTO labeled_warehouse_images (id,"warehouseId","imageUrl") VALUES ($1,$1,$2)',[id,image]);
    }
    await t.test('claims are exclusive and restricted to the requested image',async()=>{
      const claims=await Promise.all([repository.claim('label',{imageId:1,limit:1}),repository.claim('label',{imageId:1,limit:1})]);
      assert.equal(claims.flat().length,1);
      assert.equal((await repository.getActive(2)).labelAttempts,0);
      const claim=claims.flat()[0];
      assert.equal(await repository.complete('label',{...claim,labelClaimToken:'stale'},{classification:'DOCUMENT',description:'plan',confidence:.9,model:'test'}),0);
      assert.equal(await repository.complete('label',claim,{classification:'DOCUMENT',description:'plan',confidence:.9,model:'test'}),1);
      const saved=await repository.getActive(1);assert.equal(saved.documentStatus,'PENDING');assert.equal(saved.manualSentinel,'preserve-me');
      assert.equal((await repository.claim('label',{imageId:1,limit:1})).length,0);
    });
    await t.test('document and website assessment preserve successful labels',async()=>{
      const [doc]=await repository.claim('document',{imageId:1,limit:1});
      await repository.complete('document',doc,{documentKind:'LAYOUT'});
      const [approval]=await repository.claim('website',{imageId:1,limit:1});
      await repository.complete('website',approval,{decision:'BLOCK',qualityTier:'T2',assessment:{model:'gpt-5.6-luna'}});
      const saved=await repository.getActive(1);
      assert.equal(saved.classification,'DOCUMENT');assert.equal(saved.description,'plan');assert.equal(saved.documentKind,'LAYOUT');assert.equal(saved.websiteStatus,'READY');
      assert.equal((await repository.claim('website',{imageId:1,limit:1})).length,0);
    });
    await t.test('expired exhausted claims are updated only for the requested image',async()=>{
      await pool.query(`UPDATE labeled_warehouse_images SET "labelStatus"='RUNNING',"labelAttempts"=5,"labelLeaseUntil"=now()-interval '1 minute' WHERE id IN (2,3)`);
      await repository.claim('label',{imageId:2,limit:1});
      assert.equal((await repository.getActive(2)).labelStatus,'FAILED');assert.equal((await repository.getActive(3)).labelStatus,'RUNNING');
    });
    await t.test('JPEG publication changes only JPEG fields and rejects changed classification',async()=>{
      const row=await repository.getActive(1);
      assert.equal(await jpeg.publish(prisma,row,{url:base+'/jpeg/1.jpg',bytes:1000,version:jpeg.DOCUMENT_VERSION}),true);
      const after=await repository.getActive(1);
      const omit=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!key.startsWith('jpeg')));
      assert.deepEqual(omit(after),omit(row));
      await pool.query(`UPDATE labeled_warehouse_images SET classification='INDOOR' WHERE id=1`);
      assert.equal(await jpeg.publish(prisma,after,{url:base+'/jpeg/changed.jpg',bytes:999,version:jpeg.DOCUMENT_VERSION}),false);
    });
    await t.test('removed media is ineligible even when legacy photos still reference it',async()=>{
      await pool.query(`UPDATE "Warehouse" SET media='{"images":[]}'::jsonb WHERE id=4`);
      assert.equal(await repository.getActive(4),null);
      assert.equal((await repository.claim('website',{imageId:4,limit:1})).length,0);
    });
    await t.test('legacy WebP projection preserves raw media and missing slots',async()=>{
      await pool.query('UPDATE "Warehouse" SET photos=$1 WHERE id=5',[JSON.stringify([base+'/5.jpg',base+'/missing.jpg'])]);
      await pool.query(`UPDATE labeled_warehouse_images SET "webpUrl"=$1,"webpStatus"='READY' WHERE id=5`,[base+'/webp/5.webp']);
      await repository.projectLegacy(5);
      const {rows:[row]}=await pool.query('SELECT media,"photosWebp" FROM "Warehouse" WHERE id=5');
      assert.deepEqual(row.media,{images:[base+'/5.jpg']});assert.deepEqual(JSON.parse(row.photosWebp),[base+'/webp/5.webp',null]);
    });
    await t.test('geocoding rejects a result after the Maps URL was edited',async()=>{
      const repo=geocodeRepository(prisma),row=await repo.get(2);
      await pool.query('UPDATE "Warehouse" SET "googleLocation"=$1 WHERE id=2',['https://maps.google.com/?q=13,78']);
      assert.equal(await repo.publish(row,{lat:12,lng:77,via:'test'}),false);
      assert.equal((await repo.get(2)).latitude,null);
      assert.equal(await repo.publish(await repo.get(2),{lat:13,lng:78,via:'test'}),true);
    });
    await t.test('geocoding preserves a concurrent explicit coordinate edit',async()=>{
      const repo=geocodeRepository(prisma),row=await repo.get(3);
      await pool.query('INSERT INTO "WarehouseData" ("warehouseId",latitude,longitude) VALUES (3,10,76)');
      assert.equal(await repo.publish(row,{lat:12,lng:77,via:'test'}),false);
      assert.equal((await repo.get(3)).latitude,10);
    });
    await t.test('proximity preserves current terminal answers and fences coordinate changes',async()=>{
      const repo=new ProximityRepository(prisma),warehouse={id:2,lat:13,lng:78};
      const row={category:'hospital',status:'NO_ROUTE',landmarkName:null,poiSource:null,poiId:null,poiLat:null,poiLng:null,roadKm:null,driveMinutes:null,provider:'mapbox',profile:'driving',candidates:0,warnings:[],computedFromLat:13,computedFromLng:78,poiWatermark:null};
      assert.equal(await repo.upsertCurrent(warehouse,[row]),1);
      assert.equal(await repo.upsertCurrent(warehouse,[{...row,status:'OK',roadKm:7}]),0);
      assert.equal((await repo.rowsFor(2))[0].status,'NO_ROUTE');
      await pool.query('UPDATE "WarehouseData" SET latitude=14 WHERE "warehouseId"=2');
      assert.equal(await repo.upsertCurrent(warehouse,[row]),0);
    });
    await t.test('the complete registry supports read-only dry runs without external calls',async()=>{
      const services=createEnrichmentServices({prisma}),originalFetch=globalThis.fetch;
      globalThis.fetch=()=>assert.fail('dry run called an external service');
      try {
        for(const service of services.list()) {
          const result=await services.run(service.name,{[service.input]:service.input==='imageId'?1:2,dryRun:true});
          assert.equal(result.status,'DRY_RUN',service.name);
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM "CronRunLog"')).rows[0].n,0);
      } finally {globalThis.fetch=originalFetch;services.stop();}
    });
  } finally {await prisma.$disconnect();await pool.end();}
});
