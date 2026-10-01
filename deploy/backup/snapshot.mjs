import pg from 'pg';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open,writeFile,readFile,mkdtemp,rm,stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identifier=value=>'"'+value.replaceAll('"','""')+'"';
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const timeout=()=>AbortSignal.timeout(20*60*1000);
export function postgresEnvironment(connectionString) {
  const url=new URL(connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol) || url.port==='6543' || url.searchParams.get('pgbouncer')==='true') throw new Error('Backup requires direct or session-mode PostgreSQL');
  return {PATH:process.env.PATH,LANG:'C.UTF-8',PGHOST:url.hostname,PGPORT:url.port||'5432',
    PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
    PGSSLMODE:url.searchParams.get('sslmode')||'prefer',PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c statement_timeout=1200000 -c lock_timeout=10000'};
}
// Stdout goes straight to disk. Neither process arguments nor errors contain the DB URL.
export async function command(name,args,{commands={},env,cwd,output,input,inputFile,signal=timeout()}={}) {
  signal.throwIfAborted();
  const [executable,...prefix]=commands[name]??[name];
  const file=output?await open(output,'wx',0o600):null;
  let child,killTimer,failed=false;
  const abort=()=>{
    child.kill('SIGTERM');
    killTimer??=setTimeout(()=>child.kill('SIGKILL'),2000).unref();
  };
  try {
    child=spawn(executable,[...prefix,...args],{env,cwd,
      stdio:[input||inputFile?'pipe':'ignore',file?.fd??'ignore','ignore']});
    // Abort/spawn errors alone do not prove exit. Wait for close before removing
    // the SIGKILL deadline or closing an output descriptor still used by a child.
    const completed=new Promise(resolve=>{
      child.once('error',()=>{failed=true;});
      child.once('close',code=>{if(code!==0) failed=true;resolve();});
    });
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted) abort();
    const feeding=(inputFile?pipeline(createReadStream(inputFile),child.stdin)
      :input?pipeline(Readable.from([input]),child.stdin):Promise.resolve())
      .catch(()=>{failed=true;abort();});
    await Promise.all([completed,feeding]);
    if(failed || signal.aborted) throw new Error(`Backup command failed: ${name}`);
  } finally {
    signal.removeEventListener('abort',abort);clearTimeout(killTimer);await file?.close();
  }
}

function databaseSession(connectionString) {
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,timeout()]);
  const client=new pg.Client({connectionString,connectionTimeoutMillis:10000,query_timeout:20*60*1000});
  let closing;
  const close=()=>closing??=client.end().catch(()=>{});
  client.on('error',()=>abort.abort());
  signal.addEventListener('abort',()=>{void close();},{once:true});
  return {client,signal,close};
}

export function validateManifest(manifest) {
  const invalid=()=>{throw new Error('Incomplete or invalid backup manifest');};
  const names=(values,valid)=>Array.isArray(values) && values.every(valid) && new Set(values).size===values.length;
  const schema=value=>typeof value==='string' && /^[_a-z][_a-z0-9]{0,62}$/.test(value) && value!=='pgmq';
  if(!manifest || manifest.format!=='wareongo-postgres-queue-v1'
    || !names(manifest.schemas,schema) || !manifest.schemas.length
    || !names(manifest.queues,q=>typeof q==='string' && /^[a-z][a-z0-9_]{0,46}$/.test(q))
    || !Array.isArray(manifest.extensions) || !Array.isArray(manifest.tables) || !Array.isArray(manifest.sequences)
    || !manifest.files || typeof manifest.files!=='object' || Array.isArray(manifest.files)) invalid();
  const extensions=manifest.extensions;
  if(!names(extensions.map(e=>e?.name),value=>typeof value==='string' && /^[a-z][a-z0-9_-]{0,62}$/.test(value))
    || extensions.some(e=>typeof e.schema!=='string' || !/^[_a-z][_a-z0-9]{0,62}$/.test(e.schema)
      || typeof e.version!=='string' || !/^[a-zA-Z0-9_.+-]{1,64}$/.test(e.version))) invalid();
  const pgmq=extensions.find(e=>e.name==='pgmq');
  if(pgmq && (pgmq.version!=='1.5.1' || pgmq.schema!=='pgmq')) invalid();
  if(!pgmq && manifest.queues.length) invalid();
  const expectedTables=pgmq?['meta',...manifest.queues.flatMap(q=>['q_'+q,'a_'+q])]:[];
  if(manifest.tables.length!==expectedTables.length
    || !names(manifest.tables.map(t=>t?.table),name=>expectedTables.includes(name))) invalid();
  for(const table of manifest.tables) {
    if(table.file!=='pgmq-'+table.table+'.copy'
      || !names(table.columns,value=>typeof value==='string' && /^[_a-z][_a-z0-9]{0,62}$/.test(value))
      || !table.columns.length) invalid();
  }
  const expectedFiles=['domain.dump',...manifest.tables.map(t=>t.file)];
  if(Object.keys(manifest.files).length!==expectedFiles.length
    || expectedFiles.some(file=>typeof manifest.files[file]!=='string' || !/^[a-f0-9]{64}$/.test(manifest.files[file]))) invalid();
  const expectedSequences=manifest.queues.map(q=>'pgmq.q_'+q+'_msg_id_seq');
  if(manifest.sequences.length!==expectedSequences.length
    || !names(manifest.sequences.map(s=>s?.name),name=>expectedSequences.includes(name))) invalid();
  for(const sequence of manifest.sequences) {
    if(typeof sequence.last_value!=='string' || !/^[1-9][0-9]{0,18}$/.test(sequence.last_value)
      || BigInt(sequence.last_value)>9223372036854775807n || typeof sequence.is_called!=='boolean') invalid();
  }
  return manifest;
}

async function digest(path) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path)) hash.update(chunk);return hash.digest('hex');
}

export async function createSnapshot({connectionString,output,schemas=['public'],commands={},afterSnapshot=async()=>{}}) {
  if(!schemas.length || schemas.some(s=>!/^[_a-z][_a-z0-9]*$/.test(s) || s==='pgmq')) throw new Error('Invalid backup schemas');
  const env=postgresEnvironment(connectionString),{client,signal,close}=databaseSession(connectionString);
  const stage=await mkdtemp(join(dirname(resolve(output)),'.enrichment-snapshot-'));
  let committed=false;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='20min'; SET LOCAL statement_timeout='20min'");
    const {rows:[snapshot]}=await client.query('SELECT pg_export_snapshot() AS id, pg_backend_pid() AS pid, current_setting(\'server_version\') AS version');
    if(!/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-\d+$/.test(snapshot.id)) throw new Error('Invalid exported snapshot');
    const {rows:extensions}=await client.query(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql'`);
    const pgmq=extensions.find(e=>e.name==='pgmq');
    if(pgmq && pgmq.version!=='1.5.1') throw new Error('Unsupported PGMQ backup version');
    const queues=pgmq?(await client.query('SELECT * FROM pgmq.meta ORDER BY queue_name')).rows:[];
    if(queues.some(q=>!/^[a-z][a-z0-9_]{0,46}$/.test(q.queue_name) || q.is_partitioned || q.is_unlogged)) throw new Error('Unsupported queue layout');
    const hasEnrichment=(await client.query("SELECT to_regnamespace('enrichment') IS NOT NULL AS present")).rows[0].present;
    const selected=[...new Set([...schemas,...(hasEnrichment?['enrichment']:[])])];
    const manifest={format:'wareongo-postgres-queue-v1',createdAt:new Date().toISOString(),serverVersion:snapshot.version,
      schemas:selected,extensions,queues:queues.map(q=>q.queue_name),tables:[],sequences:[],files:{}};
    await afterSnapshot({backendPid:snapshot.pid});
    await command('pg_dump',['--format=custom','--no-owner','--no-privileges','--snapshot='+snapshot.id,...selected.map(s=>'--schema='+s)],
      {commands,env,signal,output:join(stage,'domain.dump')});
    const tables=pgmq?['meta',...queues.flatMap(q=>['q_'+q.queue_name,'a_'+q.queue_name])]:[];
    for(const table of tables) {
      const columns=(await client.query(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,['pgmq.'+table])).rows.map(r=>r.attname);
      const name='pgmq-'+table+'.copy';
      await command('psql',['-XqAt','--set=ON_ERROR_STOP=1'],{commands,env,signal,output:join(stage,name),
        input:`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT ${literal(snapshot.id)}; COPY pgmq.${identifier(table)} (${columns.map(identifier).join(',')}) TO STDOUT; COMMIT;`});
      manifest.tables.push({table,columns,file:name});
    }
    for(const queue of queues) {
      const table='q_'+queue.queue_name;
      const sequence=(await client.query('SELECT pg_get_serial_sequence($1,\'msg_id\') AS name',['pgmq.'+table])).rows[0].name;
      if(!/^pgmq\.q_[a-z0-9_]+_msg_id_seq$/.test(sequence)) throw new Error('Unexpected queue sequence');
      const state=(await client.query(`SELECT last_value::text,is_called FROM ${sequence}`)).rows[0];
      // Sequence state is not MVCC: a later/higher value is safe and avoids ID reuse.
      manifest.sequences.push({name:sequence,...state});
    }
    await client.query('COMMIT');committed=true;
    for(const name of ['domain.dump',...manifest.tables.map(t=>t.file)]) manifest.files[name]=await digest(join(stage,name));
    validateManifest(manifest);
    await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
    await command('tar',['-cf','-','-C',stage,'.'],{commands,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},output,signal});
    return {format:manifest.format,queues:manifest.queues,schemas:selected};
  } finally {
    if(!committed) await client.query('ROLLBACK').catch(()=>{});
    await close();
    await rm(stage,{recursive:true,force:true});
  }
}

// Restores only into an empty disposable/replacement database. Workers stay stopped.
export async function restoreSnapshot({connectionString,directory,commands={}}) {
  const manifest=validateManifest(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')));
  for(const [file,sha] of Object.entries(manifest.files)) {
    if(!/^(domain\.dump|pgmq-[a-z0-9_]+\.copy)$/.test(file) || await digest(join(directory,file))!==sha) throw new Error('Backup checksum mismatch');
  }
  const env=postgresEnvironment(connectionString),{client,signal,close}=databaseSession(connectionString);
  try {
    await client.connect();
    const existing=(await client.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','S')
      AND NOT EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') LIMIT 1`,[[...manifest.schemas,'pgmq']])).rowCount;
    if(existing) throw new Error('Restore requires an empty database');
    if((await client.query("SELECT to_regclass('pgmq.meta') IS NOT NULL AS present")).rows[0].present
      && (await client.query('SELECT 1 FROM pgmq.meta LIMIT 1')).rowCount) throw new Error('Restore requires an empty database');
    for(const e of manifest.extensions) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(e.schema)}`);
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${identifier(e.name)} WITH SCHEMA ${identifier(e.schema)} VERSION ${literal(e.version)}`);
      const installed=(await client.query('SELECT e.extversion AS version,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=$1',[e.name])).rows[0];
      if(installed.version!==e.version || installed.schema!==e.schema) throw new Error('Restore extension version or schema mismatch');
    }
    if(manifest.extensions.some(e=>e.name==='pgmq')) {
      for(const name of manifest.queues) await client.query('SELECT pgmq.create($1)',[name]);
      await client.query('TRUNCATE pgmq.meta');
      // psql reads COPY files from stdin in a separate stream; no whole-queue buffer.
      for(const table of manifest.tables) {
        if(!['meta',...manifest.queues.flatMap(q=>['q_'+q,'a_'+q])].includes(table.table)) throw new Error('Invalid queue table');
        const columns=(await client.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass
          AND attnum>0 AND NOT attisdropped ORDER BY attnum`,['pgmq.'+table.table])).rows.map(r=>r.attname);
        if(JSON.stringify(columns)!==JSON.stringify(table.columns)) throw new Error('Queue column layout mismatch');
        await command('psql',['-XqAt','--set=ON_ERROR_STOP=1','--command',
          `COPY pgmq.${identifier(table.table)} (${table.columns.map(identifier).join(',')}) FROM STDIN`],
          {commands,env,signal,inputFile:join(directory,table.file)});
      }
      for(const s of manifest.sequences) {
        if(!manifest.queues.some(q=>s.name==='pgmq.q_'+q+'_msg_id_seq') || !/^\d+$/.test(s.last_value)) throw new Error('Invalid queue sequence');
        await client.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)',[s.name,s.last_value,s.is_called]);
      }
      await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC');
    }
    // Fresh databases already contain public; extension schemas may also exist.
    // Precreate selected schemas and omit only their CREATE SCHEMA TOC entries.
    for(const schema of manifest.schemas) {
      if(!/^[_a-z][_a-z0-9]*$/.test(schema)) throw new Error('Invalid backup schema');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`);
    }
    const scratch=await mkdtemp(join(directory,'.restore-'));
    try {
      const catalog=join(scratch,'catalog.list'),selected=join(scratch,'selected.list');
      await command('pg_restore',['--list'],{commands,env,signal,inputFile:join(directory,'domain.dump'),output:catalog});
      if((await stat(catalog)).size>4*1024*1024) throw new Error('Restore catalog exceeds limit');
      const toc=(await readFile(catalog,'utf8')).split('\n').filter(line=>!/^\d+; \d+ \d+ SCHEMA - /.test(line)).join('\n');
      await writeFile(selected,toc,{mode:0o600});
      await command('pg_restore',['--no-owner','--no-privileges','--exit-on-error','--use-list='+selected,'--dbname='+env.PGDATABASE],
        {commands,env,signal,inputFile:join(directory,'domain.dump')});
    } finally {await rm(scratch,{recursive:true,force:true});}
    // Dumps omit ACLs; wrapper grants must be reinstalled deliberately after recovery.
    if(manifest.schemas.includes('enrichment')) await client.query('REVOKE ALL ON SCHEMA enrichment FROM PUBLIC; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA enrichment FROM PUBLIC');
    return manifest;
  } finally {await close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.argv[2]==='restore' && process.argv.length===4) {
      await restoreSnapshot({connectionString:process.env.BACKUP_DATABASE_URL,directory:resolve(process.argv[3])});
      console.log('Database and queue restored; validate and reinstall private wrapper grants before starting workers.');
    } else if(process.argv[2]==='create' && process.argv.length===4) {
      console.log(JSON.stringify(await createSnapshot({connectionString:process.env.BACKUP_DATABASE_URL,output:resolve(process.argv[3]),schemas:(process.env.BACKUP_SCHEMAS||'public').split(',').map(s=>s.trim())})));
    } else throw new Error('Usage: snapshot.mjs create <bundle.tar> | restore <extracted-directory>');
  } catch {console.error('Database/queue backup or restore failed; destination is not ready for use.');process.exitCode=1;}
}
