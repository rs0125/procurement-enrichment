import { subjectId } from './contract.mjs';

export function queueSettings(environment = {}) {
  const mode = environment.ENRICHMENT_DELIVERY_MODE ?? 'cron';
  const role = environment.ENRICHMENT_PROCESS_ROLE ?? 'worker';
  if (!['cron', 'shadow', 'queue'].includes(mode) || !['api', 'worker'].includes(role)) {
    throw new Error('Invalid enrichment delivery mode or process role');
  }
  const raw=environment.ENRICHMENT_QUEUE_TRIAL_SUBJECTS;
  const trial=raw===undefined?undefined:trialSubjects(JSON.parse(raw));
  return Object.freeze({...(trial?{trialSubjects:trial}:{}),mode, role, canConsume: mode === 'queue' && role === 'worker'});
}

// A short supervised trial uses explicit warehouse AND registry image IDs.
// Missing configuration is unrestricted; malformed/empty configuration fails closed.
export function trialSubjects(value) {
  if(value===undefined) return undefined;
  if(!value || typeof value!=='object' || Array.isArray(value)
    || Object.keys(value).some(key=>!['warehouseIds','imageIds'].includes(key))) throw new Error('Invalid queue trial subjects');
  const result={};
  for(const key of ['warehouseIds','imageIds']) {
    if(!Array.isArray(value[key]) || value[key].length>100) throw new Error('Invalid queue trial subjects');
    result[key]=Object.freeze([...new Set(value[key].map(subjectId))]);
  }
  if(!result.warehouseIds.length && !result.imageIds.length) throw new Error('Empty queue trial subjects');
  return Object.freeze(result);
}
export function trialAllows(input,trial) {
  return !trial || trial[['refresh-warehouse','geocode','proximity'].includes(input.action)?'warehouseIds':'imageIds'].includes(input.subjectId);
}
