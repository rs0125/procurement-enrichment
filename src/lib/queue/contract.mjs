export const QUEUE_CONTRACT_VERSION = 'pgmq-1.5.1-actions-v2';
export const QUEUE_NAME = 'enrichment_jobs';
export const DEAD_QUEUE_NAME = 'enrichment_dead';
export const ACTIONS = Object.freeze(['refresh-warehouse', 'geocode', 'proximity',
  'image-label', 'document-kind', 'website-approval', 'webp', 'jpeg']);
export const LANES = Object.freeze(['live', 'backfill']);
export const VISIBILITY_SECONDS = 300;
export const ACTION_TIMEOUT_MS = 180000;
export const MAX_FOLLOWUPS = 50;
export const MAX_DELAY_SECONDS = 7 * 86400;

function invalid() {
  const error = new Error('Invalid queue input');
  error.code = 'invalid_queue_input'; error.statusCode = 400;
  return error;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function subjectId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)
    || BigInt(value) > 2147483647n) throw invalid();
  return value;
}
export function messageId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)
    || BigInt(value) > 9223372036854775807n) throw invalid();
  return value;
}
export function message(input) {
  if (!object(input) || Object.keys(input).some(key => !['v', 'action', 'subjectId', 'lane'].includes(key))
    || input.v !== 1 || !ACTIONS.includes(input.action) || !LANES.includes(input.lane)
    || typeof input.subjectId !== 'string') throw invalid();
  return Object.freeze({v: 1, action: input.action, subjectId: subjectId(input.subjectId), lane: input.lane});
}
export function request(action, id, lane = 'live') {
  return message({v: 1, action, subjectId: subjectId(id), lane});
}
export function receipt(input) {
  if (!object(input) || !Number.isInteger(input.read_ct) || input.read_ct < 1
    || input.read_ct > 2147483647) throw invalid();
  return Object.freeze({msg_id: messageId(input.msg_id), read_ct: input.read_ct});
}
export function delaySeconds(value, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > MAX_DELAY_SECONDS) throw invalid();
  return value;
}
export function reasonCode(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw invalid();
  return value;
}
export function followups(values) {
  if (!Array.isArray(values) || values.length > MAX_FOLLOWUPS) throw invalid();
  return values.map(value => message(value));
}
export function disposition(value) {
  if (!object(value)) throw invalid();
  if(value.kind==='settled' && ['completed','deferred','stale'].includes(value.state) && Object.keys(value).every(k=>['kind','state'].includes(k))) return {kind:'settled',state:value.state};
  if (value.kind === 'done') {
    if (Object.keys(value).some(key => !['kind', 'followups'].includes(key))) throw invalid();
    return {kind: 'done', followups: followups(value.followups ?? [])};
  }
  if (value.kind === 'defer' || value.kind === 'retry') {
    if (Object.keys(value).some(key => !['kind', 'delaySeconds', 'reason', 'followups'].includes(key))) throw invalid();
    return {kind: value.kind, delaySeconds: delaySeconds(value.delaySeconds, 1), reason: reasonCode(value.reason), followups: followups(value.followups ?? [])};
  }
  if (value.kind === 'terminal') {
    if (Object.keys(value).some(key => !['kind', 'reason'].includes(key))) throw invalid();
    return {kind: 'terminal', reason: reasonCode(value.reason)};
  }
  // An HTTP 200 / action READY response is not sufficient to acknowledge delivery.
  throw invalid();
}
