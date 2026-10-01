import pg from 'pg';
import { mkdir,chmod,writeFile,readFile,stat,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSnapshot,command } from './snapshot.mjs';

async function record({connectionString,started,status,metadata=null,notes=null}) {
  const client=new pg.Client({connectionString,connectionTimeoutMillis:10000,statement_timeout:10000});
  client.on('error',()=>{});
  try {
    await client.connect();
    await client.query(`INSERT INTO "CronRunLog" ("jobName","ranAt",status,"durationMs",metadata,notes)
      VALUES ('backup-db',$1,$2,$3,$4::jsonb,$5)`,[started,status,
      Math.max(0,Math.min(2147483647,Date.now()-started.getTime())),metadata&&JSON.stringify(metadata),notes]);
  } finally {await client.end().catch(()=>{});}
}

export async function recordFailure({directory,connectionString,write=record}) {
  const marker=join(directory,'.last_start');
  let started=new Date();
  try {
    const value=(await readFile(marker,'utf8')).trim();
    if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
      const parsed=new Date(value.replace(' ','T')+'Z');
      if(Number.isFinite(parsed.getTime())) started=parsed;
    }
  } catch(error) {if(error.code!=='ENOENT') throw error;}
  await write({connectionString,started,status:'failure',notes:'backup unit failed; inspect its private journal'});
  // Retain the marker if failure logging itself fails.
  await rm(marker,{force:true});
}

// The systemd manager supplies credentials to the unprivileged backup account.
// Neither process arguments nor error output contain database URLs.
async function main() {
  const {BACKUP_DATABASE_URL,DATABASE_URL,S3_BUCKET}=process.env;
  const directory=process.env.BACKUP_DIR||'/var/backups/warehouse-geocoder';
  if(process.argv[2]==='--failure') {
    if(!DATABASE_URL) throw new Error('Missing logging configuration');
    await recordFailure({directory,connectionString:DATABASE_URL});return;
  }
  const started=new Date(),stamp=started.toISOString().replace(/[-:.]/g,'');
  const filename=`dump-${stamp}-${process.pid}.tar`,output=join(directory,filename),marker=join(directory,'.last_start');
  let created=false;
  try {
    if(!BACKUP_DATABASE_URL || !DATABASE_URL || !S3_BUCKET) throw new Error('Missing backup configuration');
    await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
    await writeFile(marker,started.toISOString().replace('T',' ').replace(/\.\d+Z$/,'')+'\n',{mode:0o600});created=true;
    console.log('[backup] creating consistent database and queue snapshot');
    const metadata=await createSnapshot({connectionString:BACKUP_DATABASE_URL,output,
      schemas:(process.env.BACKUP_SCHEMAS||'public').split(',').map(s=>s.trim())});
    const bytes=(await stat(output)).size;
    const prefix=process.env.S3_PREFIX||'supabase/warehouse-geocoder';
    const key=`${prefix}/${started.toISOString().slice(0,10).replaceAll('-','/')}/${filename}`;
    await command('aws',['s3','cp',output,`s3://${S3_BUCKET}/${key}`,'--only-show-errors'],{env:process.env});
    await record({connectionString:DATABASE_URL,started,status:'success',metadata:{...metadata,s3Bucket:S3_BUCKET,s3Key:key,bytes}});
    await rm(marker);console.log(`[backup] uploaded ${bytes} bytes`);
  } finally {if(created) await rm(output,{force:true});}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await main();}
  catch {console.error('[backup] failed; inspect the private service journal');process.exitCode=1;}
}
