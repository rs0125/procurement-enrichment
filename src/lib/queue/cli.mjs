import { request } from './contract.mjs';

export async function runQueueCommand(args, {queue, planner}) {
  const [command, ...options] = args;
  if (command === 'doctor' && !options.length) return queue.doctor();
  if (command === 'stats' && !options.length) { await queue.assertReady(); return queue.stats(); }
  const values = new Map();
  for (const option of options) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(option);
    if (!match || values.has(match[1])) throw new Error('Invalid queue command');
    values.set(match[1], match[2] ?? true);
  }
  if (command === 'plan' && values.has('warehouse-id')
    && [...values.keys()].every(key => ['warehouse-id','include-jpeg'].includes(key))
    && (!values.has('include-jpeg') || values.get('include-jpeg') === true)) {
    return planner.preview(values.get('warehouse-id'), {includeJpeg: values.has('include-jpeg')});
  }
  if (command === 'enqueue' && values.has('action') && values.has('id')
    && [...values.keys()].every(key => ['action','id','lane','dry-run'].includes(key))
    && (!values.has('dry-run') || values.get('dry-run') === true)) {
    const input = request(values.get('action'), values.get('id'), values.get('lane') ?? 'live');
    if (values.has('dry-run')) return {status: 'DRY_RUN', message: input};
    await queue.assertReady();
    return {status: 'QUEUED', ...await queue.enqueue(input), processingEnabledByThisCommand: false};
  }
  throw new Error('Use queue doctor, stats, plan --warehouse-id=123, or enqueue --action=webp --id=456 [--lane=backfill] [--dry-run]');
}
