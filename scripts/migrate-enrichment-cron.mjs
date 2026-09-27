import { writeFile, readFile } from 'node:fs/promises';
import { prisma, disconnect } from '../src/config/prisma.mjs';
import { ENRICHMENT_CRON, ENRICHMENT_ENDPOINT, planCronHandoff } from '../src/lib/runtime/cronHandoff.mjs';

const apply = process.argv.includes('--apply');
const backup = '/var/tmp/warehouse-enricher-cron-handoff.json';
try {
  const [job] = await prisma.$queryRaw`SELECT jobid,jobname,schedule,active,command FROM cron.job WHERE jobname=${ENRICHMENT_CRON}`;
  if (!job) throw new Error('cron_missing');
  const plan = planCronHandoff(job, process.env.CRON_SECRET);
  console.log(JSON.stringify({ ...plan.summary, apply }));
  if (apply && plan.summary.changed) {
    const response = await fetch(ENRICHMENT_ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CRON_SECRET}` },
      body: JSON.stringify({ dryRun: true }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('readiness_failed');
    const data = await response.json();
    if (data.status !== 'DRY_RUN' || !data.configured?.images || !data.configured?.websiteImages || !data.configured?.proximity
      || !data.stages?.labels || !data.stages?.documents || !data.stages?.websiteImages || !data.stages?.proximity) throw new Error('readiness_failed');
    const saved = JSON.stringify({ ...job, jobid: String(job.jobid) });
    try { await writeFile(backup, saved, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== saved) throw new Error('backup_conflict'); }
    await prisma.$transaction(async tx => {
      const [current] = await tx.$queryRaw`SELECT command,schedule,active FROM cron.job WHERE jobid=${job.jobid}`;
      if (!current || current.command !== job.command || current.schedule !== job.schedule || current.active !== job.active) throw new Error('cron_changed');
      await tx.$executeRaw`SELECT cron.alter_job(${job.jobid}::bigint,command := ${plan.command})`;
    }, { isolationLevel: 'Serializable' });
    console.log('Existing cron retargeted; schedule and active state preserved. Private rollback snapshot saved on this host.');
  }
} catch {
  console.error('Cron handoff failed; inspect readiness and the private host snapshot. Credentials are not printed.');
  process.exitCode = 1;
} finally { await disconnect(); }
