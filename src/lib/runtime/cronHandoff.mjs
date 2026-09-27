export const ENRICHMENT_CRON = 'sweep-warehouse-image-labels';
export const ENRICHMENT_ENDPOINT = 'https://wareongo-cronjobs.duckdns.org/cron/enrichment';

export function planCronHandoff(job, secret) {
  if (job.jobname !== ENRICHMENT_CRON || !secret) throw new Error('Unexpected cron or missing credential');
  const match = job.command.match(/\burl\s*(?::=|=>)\s*'((?:''|[^'])*)'/i);
  if (!match) throw new Error('Unsupported cron URL format');
  const before = match[1].replace(/''/g, "'");
  if (!['https://u3yrpp3726.ap-south-1.awsapprunner.com/api/enrichment/sweep', ENRICHMENT_ENDPOINT].includes(before)) {
    throw new Error('Unexpected existing cron destination');
  }
  const auth = /'(x-webhook-secret|authorization)'\s*,\s*'((?:''|[^'])*)'/i;
  if (!auth.test(job.command)) throw new Error('Unsupported cron authentication format');
  let command = job.command.replace(match[0], match[0].replace(match[1], ENRICHMENT_ENDPOINT));
  command = command.replace(auth, () => `'Authorization', 'Bearer ${secret.replaceAll("'", "''")}'`);
  return { command, summary: { jobid: String(job.jobid), jobname: job.jobname, schedule: job.schedule,
    active: job.active, previousEndpoint: before, endpoint: ENRICHMENT_ENDPOINT, changed: command !== job.command } };
}
