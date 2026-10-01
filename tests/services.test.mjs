import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageLabelService } from '../src/services/enrichment/imageLabel.mjs';
import { createDocumentKindService } from '../src/services/enrichment/documentKind.mjs';
import { createWebsiteApprovalService } from '../src/services/enrichment/websiteApproval.mjs';
import { createWebpService } from '../src/services/enrichment/webp.mjs';
import { createJpegService } from '../src/services/enrichment/jpeg.mjs';
import { createGeocodeService } from '../src/services/enrichment/geocode.mjs';
import { createProximityService } from '../src/services/enrichment/proximity.mjs';
import { createExecutor,memoryAvailable } from '../src/lib/runtime/executor.mjs';
import jpeg from '../src/lib/images/jpegPolicy.cjs';

const signal=()=>new AbortController().signal;
function fixture(extra={}) {
  const row={id:1,imageUrl:'https://images.example/one.jpg',warehouseIds:[1],labelStatus:'PENDING',webpStatus:'PENDING',jpegStatus:'PENDING',...extra};
  const calls=[];
  const repository={prisma:{},getActive:async()=>row,
    claim:async(stage,options)=>{calls.push(['claim',stage,options]);return [{id:1,imageUrl:row.imageUrl}];},
    complete:async(stage,_row,result)=>{calls.push(['complete',stage,result]);return 1;},
    fail:async(...args)=>calls.push(['fail',...args]),projectLegacy:async()=>calls.push(['project'])};
  return {row,calls,repository,configured:()=>true,invalidate:async()=>calls.push(['invalidate'])};
}
test('scene labeling remains separate from document classification and uses Terra',async()=>{
  const f=fixture();let chosen;
  const run=createImageLabelService({...f,classify:async(model)=>{chosen=model;return {classification:'DOCUMENT',description:'Floor plan',confidence:.9};}});
  assert.equal((await run({imageId:1,signal:signal()})).status,'READY');
  assert.equal(chosen,'gpt-5.6-terra');assert.deepEqual(f.calls.filter(c=>c[0]==='claim').map(c=>c[1]),['label']);
  assert.equal(f.calls.find(c=>c[0]==='complete')[2].documentKind,undefined);
});
test('document classification publishes only the subtype',async()=>{
  const f=fixture({classification:'DOCUMENT'});
  const run=createDocumentKindService({...f,classify:async()=>({documentKind:'LAYOUT',confidence:.9,reason:'plan'})});
  await run({imageId:1,signal:signal()});
  assert.deepEqual(f.calls.find(c=>c[0]==='complete').slice(1),['document',{documentKind:'LAYOUT'}]);
});
test('dry run reads without claiming, calling a provider or invalidating caches',async()=>{
  const f=fixture();const run=createImageLabelService({...f,classify:async()=>assert.fail('provider called')});
  assert.equal((await run({imageId:1,dryRun:true})).status,'DRY_RUN');assert.deepEqual(f.calls,[]);
});
test('completed website decisions are not reviewed again',async()=>{
  const f=fixture({websiteStatus:'READY',websiteDecision:'ALLOW'});f.repository.claim=async()=>[];
  const run=createWebsiteApprovalService({...f,assess:async()=>assert.fail('reviewed a completed image')});
  assert.equal((await run({imageId:1,signal:signal()})).status,'SKIPPED');
  assert.equal(f.calls.some(c=>c[0]==='complete'),false);
});
test('BLOCK is a completed assessment, not an operational failure',async()=>{
  const f=fixture();const run=createWebsiteApprovalService({...f,assess:async()=>({decision:'BLOCK',qualityTier:'T2',assessment:{model:'gpt-5.6-luna'}})});
  assert.equal((await run({imageId:1,signal:signal()})).status,'READY');
  assert.equal(f.calls.find(c=>c[0]==='complete')[2].decision,'BLOCK');assert.equal(f.calls.some(c=>c[0]==='fail'),false);
});
test('cancellation after a paid call starts retains the failed attempt',async()=>{
  const f=fixture(),abort=new AbortController();
  const run=createImageLabelService({...f,classify:async()=>{abort.abort();throw new Error('interrupted');}});
  assert.equal((await run({imageId:1,signal:abort.signal})).status,'DEFERRED');
  assert.equal(f.calls.find(c=>c[0]==='fail')[4].deferred,false);assert.equal(f.calls.some(c=>c[0]==='complete'),false);
});
test('cancellation before a provider call refunds the unused claim',async()=>{
  const f=fixture(),abort=new AbortController();
  f.repository.claim=async()=>{abort.abort();return [{id:1,imageUrl:f.row.imageUrl}];};
  const run=createImageLabelService({...f,classify:()=>assert.fail('provider called')});
  assert.equal((await run({imageId:1,signal:abort.signal})).status,'DEFERRED');
  assert.equal(f.calls.find(c=>c[0]==='fail')[4].deferred,true);
});
test('invalid provider labels cannot become ready',async()=>{
  const f=fixture(),run=createImageLabelService({...f,classify:async()=>({classification:'warehouse',description:'x',confidence:2})});
  assert.equal((await run({imageId:1,signal:signal()})).status,'FAILED');assert.equal(f.calls.some(c=>c[0]==='complete'),false);
});
test('WebP reuses a previously uploaded object without downloading or encoding',async()=>{
  const f=fixture(),store={publicBase:'https://images.example',bucket:'test',url:key=>'https://images.example/'+key,
    head:async()=>({bytes:123,modifiedAt:new Date()}),put:async()=>assert.fail('unexpected upload')};
  const run=createWebpService({...f,getStore:()=>store,temporary:async()=>assert.fail('unexpected download')});
  assert.equal((await run({imageId:1,signal:signal()})).status,'READY');
  assert.match(f.calls.find(c=>c[0]==='complete')[2].webpUrl,/\/webp\/images\//);
  assert.equal(f.calls.filter(c=>c[0]==='project').length,1);
});
test('JPEG waits for scene classification before choosing photo or document size',async()=>{
  const f=fixture();const run=createJpegService({...f,getStore:()=>assert.fail('storage initialized')});
  assert.equal((await run({imageId:1,signal:signal()})).reason,'label_required');
});
test('small valid JPEGs reuse the original URL and do not upload',async()=>{
  const f=fixture({classification:'INDOOR',labelStatus:'READY'});let result;
  const run=createJpegService({...f,getStore:()=>({publicBase:'https://images.example',head:async()=>assert.fail('storage accessed')}),
    temporary:work=>work('source','output'),download:async()=>({bytes:10000,hash:'abc'}),
    decode:async()=>({metadata:{format:'jpeg',width:640,height:480,space:'srgb'}}),publish:async(_db,_row,value)=>{result=value;return true;}});
  assert.equal((await run({imageId:1,signal:signal()})).reusedOriginal,true);
  assert.deepEqual(result,{url:f.row.imageUrl,bytes:10000,version:jpeg.REUSE_VERSION});
});
test('JPEG stale publication cannot claim success',async()=>{
  const f=fixture({classification:'OUTDOOR',labelStatus:'READY'});
  const run=createJpegService({...f,getStore:()=>({publicBase:'https://images.example'}),temporary:work=>work('source','output'),
    download:async()=>({bytes:100,hash:'abc'}),decode:async()=>({metadata:{format:'jpeg',width:640,height:480,space:'srgb'}}),publish:async()=>false});
  assert.equal((await run({imageId:1,signal:signal()})).status,'STALE');assert.equal(f.calls.some(c=>c[0]==='invalidate'),false);
});
test('single-warehouse geocoding skips existing coordinates',async()=>{
  const run=createGeocodeService({repository:{get:async()=>({googleLocation:'x',latitude:12,longitude:77})},extract:()=>assert.fail('lookup called')});
  assert.equal((await run({warehouseId:1})).status,'SKIPPED');
});
test('geocoding cancellation prevents publication',async()=>{
  const abort=new AbortController();
  const run=createGeocodeService({repository:{get:async()=>({googleLocation:'x'}),publish:()=>assert.fail('published aborted result')},warmUp:async()=>{},
    extract:async()=>{abort.abort();return {lat:12,lng:77};}});
  await assert.rejects(run({warehouseId:1,signal:abort.signal}));
});
test('proximity keeps current rows and refuses incomplete coverage',async()=>{
  const methods={warehousesToCompute:[{id:1,lat:12,lng:77}],coverage:[{category:'hospital',complete:false}],rowsFor:[]};
  const run=createProximityService({model:{bounded:async name=>methods[name]},computer:{compute:()=>assert.fail('route called')}});
  const result=await run({warehouseId:1,dryRun:true});assert.ok(result.skippedCategories.includes('hospital'));assert.ok(!result.pendingCategories.includes('hospital'));
});
test('executor defers overlap instead of buffering work in memory',async()=>{
  const execute=createExecutor({available:async()=>1024**3,rss:()=>100*1024**2});let release;
  const first=execute(()=>new Promise(resolve=>{release=resolve;}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await execute(()=>assert.fail('overlap started'))).reason,'worker_busy');release({status:'READY'});await first;
  assert.equal((await execute(async()=>({status:'READY'}))).status,'READY');
});
test('executor honors low memory and cgroup limits',async()=>{
  const execute=createExecutor({available:async()=>200*1024**2,rss:()=>1});
  assert.equal((await execute(()=>assert.fail('memory pressure ignored'))).reason,'memory_pressure');
  const values={'/proc/meminfo':'MemAvailable: 99999999 kB','/proc/self/cgroup':'0::/\n','/sys/fs/cgroup/memory.max':'536870912','/sys/fs/cgroup/memory.current':'400000000'};
  assert.equal(await memoryAvailable({read:async name=>values[name]}),136870912);
});
test('executor recycles once at its RSS limit and never admits another action',async()=>{
  let restarts=0, ownRss=390*1024**2;
  const execute=createExecutor({available:async()=>100*1024**2,rss:()=>ownRss,onMemoryLimit:()=>{restarts++;}});
  assert.equal((await execute(()=>assert.fail('work admitted over RSS limit'))).reason,'memory_pressure');
  ownRss=100*1024**2;
  assert.equal((await execute(()=>assert.fail('work admitted while draining'))).reason,'memory_pressure');
  assert.equal(restarts,1);
});
test('executor recovers from external pressure without recycling and leaves active work alone',async()=>{
  let available=200*1024**2, ownRss=100*1024**2, restarts=0, release;
  const execute=createExecutor({available:async()=>available,rss:()=>ownRss,onMemoryLimit:()=>{restarts++;}});
  assert.equal((await execute(()=>assert.fail('work admitted during external pressure'))).reason,'memory_pressure');
  assert.equal(restarts,0);
  available=1024**3;
  const first=execute(()=>new Promise(resolve=>{release=resolve;}));
  await new Promise(resolve=>setImmediate(resolve));
  ownRss=390*1024**2;
  assert.equal((await execute(()=>assert.fail('overlapping work admitted'))).reason,'worker_busy');
  assert.equal(restarts,0);
  release({status:'READY'});assert.equal((await first).status,'READY');
  assert.equal((await execute(()=>assert.fail('work admitted before recycling'))).reason,'memory_pressure');
  assert.equal(restarts,1);
});
