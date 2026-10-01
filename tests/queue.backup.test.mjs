import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createSnapshot,restoreSnapshot,command,validateManifest } from '../deploy/backup/snapshot.mjs';

import { setTimeout as delay } from 'node:timers/promises';
import { recordFailure } from '../deploy/backup/run.mjs';

const url=process.env.ENRICHER_BACKUP_TEST_DATABASE_URL;

test('backup cancellation waits for a SIGTERM-ignoring child to be killed',{timeout:10000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'enricher-abort-test-')),pidFile=join(directory,'child.pid');
  const abort=new AbortController();let pid;
  const running=command('fixture',[],{commands:{fixture:[process.execPath,'-e',
    'process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',pidFile]},
    env:{PATH:process.env.PATH},signal:abort.signal});
  const rejected=assert.rejects(running,/Backup command failed/);
  try {
    for(let i=0;i<100 && !pid;i++) {
      try {pid=Number(await readFile(pidFile,'utf8'));} catch {await delay(20);}
    }
    assert.ok(pid,'child started');abort.abort();await rejected;
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {
    abort.abort();await rejected;
    if(pid) {try {process.kill(pid,'SIGKILL');} catch {}}
    await rm(directory,{recursive:true,force:true});
  }
});

test('archive catalog readers may close input early only when explicitly allowed and successful',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'enricher-catalog-test-')),inputFile=join(directory,'large-archive');
  try {
    await writeFile(inputFile,Buffer.alloc(4*1024*1024,65));
    const commands=code=>({reader:[process.execPath,'-e',
      'process.stdin.once("data",()=>{process.stdin.destroy();process.exit('+code+');})']});
    const options={inputFile,env:{PATH:process.env.PATH}};
    await command('reader',[],{...options,commands:commands(0),allowEarlyInputClose:true});
    await assert.rejects(command('reader',[],{...options,commands:commands(1),allowEarlyInputClose:true}),/Backup command failed/);
    await assert.rejects(command('reader',[],{...options,commands:commands(0)}),/Backup command failed/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('restore refuses omitted, duplicate and mismatched queue metadata before connecting',async()=>{
  const good={format:'wareongo-postgres-queue-v1',schemas:['public','enrichment'],
    extensions:[{name:'pgmq',schema:'pgmq',version:'1.5.1'}],queues:['jobs'],
    tables:['meta','q_jobs','a_jobs'].map(table=>({table,file:'pgmq-'+table+'.copy',columns:['fixture']})),
    sequences:[{name:'pgmq.q_jobs_msg_id_seq',last_value:'1',is_called:false}],
    files:Object.fromEntries(['domain.dump','pgmq-meta.copy','pgmq-q_jobs.copy','pgmq-a_jobs.copy'].map(file=>[file,'a'.repeat(64)]))};
  assert.equal(validateManifest(good),good);
  const cases=[m=>{m.tables=[];},m=>{m.tables.pop();},m=>{m.tables[1]=m.tables[0];},
    m=>{m.tables[0].columns=['x','x'];},m=>{m.sequences=[];},m=>{m.sequences[0].is_called='false';},
    m=>{m.sequences[0].last_value='9223372036854775808';},m=>{delete m.files['domain.dump'];},
    m=>{m.tables[0].file='pgmq-q_jobs.copy';},m=>{m.extensions=[];},m=>{m.queues.push('jobs');}];
  const directory=await mkdtemp(join(tmpdir(),'enricher-manifest-test-'));
  try {
    for(const corrupt of cases) {
      const bad=structuredClone(good);corrupt(bad);
      await writeFile(join(directory,'manifest.json'),JSON.stringify(bad));
      await assert.rejects(restoreSnapshot({connectionString:'invalid',directory}),/invalid backup manifest/);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('failure logging uses bound values and keeps its marker until recorded',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'enricher-failure-test-')),marker=join(directory,'.last_start');
  try {
    await writeFile(marker,'2026-09-30 10:11:12\n');
    await assert.rejects(recordFailure({directory,connectionString:'fixture',write:async()=>{throw new Error('unavailable');}}),/unavailable/);
    assert.ok(await readFile(marker));
    let entry;await recordFailure({directory,connectionString:'fixture',write:async value=>{entry=value;}});
    assert.equal(entry.started.toISOString(),'2026-09-30T10:11:12.000Z');assert.equal(entry.status,'failure');
    await assert.rejects(readFile(marker),{code:'ENOENT'});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('streamed backup restores a consistent domain + PGMQ snapshot, including receipts and sequences',{skip:!url},async()=>{
  const parsed=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));assert.equal(parsed.pathname,'/enricher_test');
  const sourceName='enricher_backup_test',restoreName='enricher_restore_test';
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const makeUrl=name=>{const copy=new URL(url);copy.pathname='/'+name;return copy.toString();};
  const source=new pg.Client({connectionString:makeUrl(sourceName)}),restored=new pg.Client({connectionString:makeUrl(restoreName)});
  const directory=await mkdtemp(join(tmpdir(),'enricher-backup-test-'));
  const commandsFor=name=>{
    if(!process.env.ENRICHER_TEST_CONTAINER) return {};
    const engine=process.env.ENRICHER_TEST_ENGINE||'docker';assert.ok(['docker','podman'].includes(engine));
    return Object.fromEntries(['psql','pg_dump','pg_restore'].map(cmd=>[cmd,['python3',new URL('./fixtures/pg-tool.py',import.meta.url).pathname,engine,process.env.ENRICHER_TEST_CONTAINER,name,cmd]]));
  };
  let sourceCreated=false,restoreCreated=false;
  try {
    // Deliberately no DROP-if-exists: an unexpected pre-existing database needs inspection.
    await admin.query('CREATE DATABASE '+sourceName);sourceCreated=true;
    await admin.query('CREATE DATABASE '+restoreName);restoreCreated=true;
    await source.connect();await restored.connect();
    // Exercise a built-in extension schema, as production pg_cron uses pg_catalog.
    await source.query('CREATE EXTENSION pg_trgm WITH SCHEMA pg_catalog');
    await source.query('CREATE TABLE public.before_queue_fixture(id int); INSERT INTO public.before_queue_fixture VALUES(1)');
    const bare=await createSnapshot({connectionString:makeUrl(sourceName),output:join(directory,'before-queue.tar'),commands:commandsFor(sourceName)});
    assert.deepEqual(bare.queues,[]);
    await assert.rejects(createSnapshot({connectionString:makeUrl(sourceName),output:join(directory,'lost-owner.tar'),
      commands:commandsFor(sourceName),afterSnapshot:async({backendPid})=>{
        await source.query('SELECT pg_terminate_backend($1)',[backendPid]);
      }}));
    await source.query('DROP TABLE public.before_queue_fixture');
    await restored.query("CREATE EXTENSION pgmq VERSION '1.5.1'; SELECT pgmq.create('existing_fixture')");
    await source.query(await readFile(new URL('../sql/queue/001_bootstrap.sql',import.meta.url),'utf8'));
    await source.query(`CREATE TABLE public.backup_fixture(id int PRIMARY KEY,value text);
      INSERT INTO public.backup_fixture VALUES(1,'before');
      SELECT enrichment.enqueue('{"v":1,"action":"webp","subjectId":"1","lane":"live"}');
      SELECT enrichment.enqueue('{"v":1,"action":"jpeg","subjectId":"1","lane":"live"}');
      SELECT enrichment.enqueue('{"v":1,"action":"image-label","subjectId":"1","lane":"live"}');`);
    const owner=(await source.query("SELECT * FROM enrichment.claim('webp','live')")).rows[0];
    const jpeg=(await source.query("SELECT * FROM enrichment.claim('jpeg','live')")).rows[0];
    const label=(await source.query("SELECT * FROM enrichment.claim('image-label','live')")).rows[0];
    await source.query('SELECT enrichment.finish($1,$2)',[jpeg.msg_id,jpeg.read_ct]);
    await source.query("SELECT enrichment.reject($1,$2,'fixture')",[label.msg_id,label.read_ct]);
    const expected={};
    for(const table of ['q_enrichment_jobs','a_enrichment_jobs','q_enrichment_dead','a_enrichment_dead','meta']) expected[table]=(await source.query('SELECT * FROM pgmq.'+table+' ORDER BY 1')).rows;
    const bundle=join(directory,'backup.tar');
    await createSnapshot({connectionString:makeUrl(sourceName),output:bundle,commands:commandsFor(sourceName),afterSnapshot:async()=>{
      // A committed domain save and its event after export must BOTH be excluded.
      await source.query(`BEGIN; INSERT INTO public.backup_fixture VALUES(2,'after');
        SELECT enrichment.enqueue('{"v":1,"action":"webp","subjectId":"2","lane":"live"}'); COMMIT;`);
    }});
    await command('tar',['-xf',bundle,'-C',directory],{env:{PATH:process.env.PATH}});
    await assert.rejects(restoreSnapshot({connectionString:makeUrl(restoreName),directory,commands:commandsFor(restoreName)}),/empty database/);
    assert.equal((await restored.query('SELECT queue_name FROM pgmq.meta')).rows[0].queue_name,'existing_fixture');
    await restored.query("SELECT pgmq.drop_queue('existing_fixture')");
    await restoreSnapshot({connectionString:makeUrl(restoreName),directory,commands:commandsFor(restoreName)});
    assert.equal((await restored.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'")).rows[0].nspname,'pg_catalog');
    assert.deepEqual((await restored.query('SELECT * FROM public.backup_fixture ORDER BY id')).rows,[{id:1,value:'before'}]);
    for(const [table,rows] of Object.entries(expected)) assert.deepEqual((await restored.query('SELECT * FROM pgmq.'+table+' ORDER BY 1')).rows,rows,table);
    assert.equal((await restored.query('SELECT read_ct FROM pgmq.q_enrichment_jobs WHERE msg_id=$1',[owner.msg_id])).rows[0].read_ct,1);
    const sent=(await restored.query(`SELECT enrichment.enqueue('{"v":1,"action":"webp","subjectId":"3","lane":"live"}') AS id`)).rows[0].id;
    assert.ok(BigInt(sent)>BigInt(label.msg_id)+1n,'sequence must also skip IDs allocated after snapshot');
    await assert.rejects(restoreSnapshot({connectionString:makeUrl(restoreName),directory,commands:commandsFor(restoreName)}),/empty database/);
    assert.equal((await restored.query("SELECT EXISTS(SELECT FROM pg_namespace n,aclexplode(n.nspacl) a WHERE n.nspname='enrichment' AND a.grantee=0 AND a.privilege_type='USAGE') AS ok")).rows[0].ok,false);
  } finally {
    await source.end().catch(()=>{});await restored.end().catch(()=>{});
    if(restoreCreated) await admin.query('DROP DATABASE '+restoreName);
    if(sourceCreated) await admin.query('DROP DATABASE '+sourceName);
    await admin.end();await rm(directory,{recursive:true,force:true});
  }
});
