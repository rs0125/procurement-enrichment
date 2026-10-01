import { request, subjectId, MAX_FOLLOWUPS } from '../../lib/queue/contract.mjs';
import jpeg from '../../lib/images/jpegPolicy.cjs';

const stages = Object.freeze({'image-label':'label','document-kind':'document','website-approval':'website',webp:'webp'});
const instant = value => value == null ? null : new Date(value).getTime();

export function imageReadiness(action, row, now = Date.now()) {
  if (!row?.id) return {state: 'blocked', reason: 'registration_required'};
  if (action === 'jpeg') {
    if (jpeg.complete(row)) return {state: 'done', reason: 'already_ready'};
    if (!row.classification) return {state: 'waiting', reason: 'label_required'};
    if(row.jpegStatus==='UNSUPPORTED') return {state:'terminal',reason:'unsupported_source'};
    return {state:'eligible',reason:'attempt_policy_checked_at_delivery'};
  }
  const stage = stages[action];
  if (!stage) throw new Error('Unknown image action');
  if (row[`${stage}Status`] === 'READY' || (stage === 'label' && row.classification)
    || (stage === 'document' && row.documentKind)
    || (stage === 'website' && (row.hasWebsiteOverride || row.websiteOverride!=null))) return {state: 'done', reason: 'already_ready'};
  if (stage === 'document' && row.classification !== 'DOCUMENT') {
    return row.classification ? {state: 'done', reason: 'not_a_document'} : {state: 'waiting', reason: 'label_required'};
  }
  if (row[`${stage}Status`] === 'UNSUPPORTED') return {state: 'terminal', reason: 'unsupported_source'};
  // A live claim wins over exhaustion: its final in-flight attempt may still succeed.
  const lease = instant(row[`${stage}LeaseUntil`]);
  if (row[`${stage}Status`] === 'RUNNING' && Number.isFinite(lease) && lease > now) {
    return {state: 'waiting', reason: 'stage_claimed', eligibleAt: new Date(lease).toISOString()};
  }
  if (Number(row[`${stage}Attempts`] ?? 0) >= 5) return {state: 'terminal', reason: 'attempts_exhausted'};
  const next = instant(row[`${stage}NextAttemptAt`]);
  if (Number.isFinite(next) && next > now) return {state: 'waiting', reason: 'retry_cooldown', eligibleAt: new Date(next).toISOString()};
  if (!['PENDING','FAILED','RUNNING'].includes(row[`${stage}Status`])) return {state: 'blocked', reason: 'unknown_stage_status'};
  if (row[`${stage}Status`] === 'RUNNING' && !Number.isFinite(lease)) return {state: 'blocked', reason: 'invalid_stage_lease'};
  return {state: 'eligible'};
}

// A read-only planning surface, not the production fan-out/acknowledgement handler.
export function createQueuePlanner({sources, now = Date.now}) {
  return {
    async preview(warehouseId, {lane = 'live', includeJpeg = false} = {}) {
      warehouseId = subjectId(warehouseId);
      request('refresh-warehouse', warehouseId, lane);
      if (typeof includeJpeg !== 'boolean') throw new Error('Invalid JPEG option');
      const source = await sources.snapshot(warehouseId);
      if (!source) return {status: 'OBSOLETE', warehouseId, reason: 'warehouse_not_found', jobs: []};
      if (source.oversized) return {status: 'BLOCKED', warehouseId, reason: 'planner_page_limit', jobs: []};
      const jobs = [], decisions = [], seen = new Set();
      const add = (action, id) => {
        const key = `${action}:${id}`;
        if (!seen.has(key)) { seen.add(key); jobs.push(request(action, id, lane)); }
      };
      if (source.warehouse.geocodeEligible) add('geocode', warehouseId);
      const hasCoordinates = source.warehouse.latitude != null && source.warehouse.longitude != null;
      if (hasCoordinates) decisions.push({action: 'proximity', subjectId: warehouseId,
        state: 'eligible', reason: 'coverage_and_cooldown_checked_at_delivery'});
      let unregistered = 0;
      const actions = ['image-label','website-approval','webp','document-kind', ...(includeJpeg ? ['jpeg'] : [])];
      for (const row of source.images) {
        if (!row.id) { unregistered++; continue; }
        for (const action of actions) {
          const decision = imageReadiness(action, row, now());
          decisions.push({action, subjectId: String(row.id), ...decision});
          if (decision.state === 'eligible') add(action, row.id);
        }
      }
      return {status: 'PREVIEW', warehouseId, registeredImages: source.images.length - unregistered,
        unregisteredImages: unregistered, needsRegistration: unregistered > 0,
        needsPagedFanout: jobs.length > MAX_FOLLOWUPS, jobs, decisions,
        actionAdaptersAvailable: true};
    }
  };
}
