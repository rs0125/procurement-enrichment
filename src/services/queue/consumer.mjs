import { setTimeout as delay } from 'node:timers/promises';
import { createExecutor } from '../../lib/runtime/executor.mjs';
import { ACTIONS, ACTION_TIMEOUT_MS, message, disposition } from '../../lib/queue/contract.mjs';
import { queueSettings,trialSubjects,trialAllows } from '../../lib/queue/settings.mjs';
import { diagnostic } from '../../lib/runtime/diagnostics.mjs';

// Dispatch uses guarded action adapters; admission happens before claiming.
export function createQueueConsumer({queue, dispatch, settings = queueSettings(),
  execute = createExecutor(), pause = delay, random = Math.random,
  report = () => {}, now = Date.now, actionTimeoutMs = ACTION_TIMEOUT_MS} = {}) {
  if (!Number.isInteger(actionTimeoutMs) || actionTimeoutMs < 1 || actionTimeoutMs > ACTION_TIMEOUT_MS) {
    throw new Error('Invalid queue action timeout');
  }
  const enabled = queueSettings({ENRICHMENT_DELIVERY_MODE: settings.mode, ENRICHMENT_PROCESS_ROLE: settings.role}).canConsume;
  if (enabled && (typeof dispatch !== 'function' || !queue)) throw new Error('Queue-aware action adapter required');
  const trial=trialSubjects(settings.trialSubjects);
  const stop = new AbortController();
  let activeTick = null, loop = null, actionIndex = 0, completedDispatches = 0, idleStreak = 0, consecutiveUnavailable = 0;
  const stats = {claimed: 0, completed: 0, deferred: 0, terminal: 0, errors: 0, stale: 0, trialDeferred: 0};
  const startedAt=new Date(now()).toISOString();
  let lastPollAt=null,lastCompletedAt=null,lastError=null;

  async function claimNext() {
    const action = ACTIONS[actionIndex++ % ACTIONS.length];
    const lane = completedDispatches % 5 === 4 ? 'backfill' : 'live';
    return await queue.claim(action, lane) ?? await queue.claim(null, lane)
      ?? await queue.claim(null, lane === 'live' ? 'backfill' : 'live');
  }
  async function performTick() {
    if (!enabled) return {state: 'disabled'};
    if (stop.signal.aborted) return {state: 'stopped'};
    // The executor admits/reserves once, BEFORE claiming; no waiting message buffers.
    const admission = await execute(async () => {
      if (stop.signal.aborted) return {state: 'stopped'};
      const delivery = await claimNext();
      lastPollAt=new Date(now()).toISOString();
      if (!delivery) return {state: 'idle'};
      stats.claimed++; completedDispatches++;
      let input;
      try { input = message(delivery.message); }
      catch {
        const owned = await queue.reject(delivery, 'invalid_message');
        stats[owned ? 'terminal' : 'stale']++;
        return {state: owned ? 'terminal' : 'stale'};
      }
      if(!trialAllows(input,trial)) {
        // Keep non-trial work durable without running a provider or spending a
        // domain attempt. Its ordinary receipt becomes visible again in 5 min.
        const owned=await queue.defer(delivery,300);
        stats[owned?'trialDeferred':'stale']++;
        return {state:owned?'trial_deferred':'stale'};
      }
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(actionTimeoutMs)]);
      const context={action:input.action,subjectId:input.subjectId,messageId:delivery.msg_id,readCount:delivery.read_ct};
      try {
        signal.throwIfAborted();
        const result = disposition(await dispatch(input, Object.freeze({signal,
          receipt: Object.freeze({msg_id: delivery.msg_id, read_ct: delivery.read_ct}),
          publish: ({lockSource, write}) => queue.withReceipt(delivery, {lockSource, write, signal})})));
        signal.throwIfAborted();
        let owned, state;
        if (result.kind === 'settled') {
          stats[result.state]++; return {state:result.state,...context};
        }
        if (result.kind === 'done') {
          owned = await queue.finish(delivery, result.followups); state = 'completed';
        } else if (result.kind === 'terminal') {
          owned = await queue.reject(delivery, result.reason); state = 'terminal';
        } else {
          owned = result.followups.length ? await queue.waitFor(delivery,result.delaySeconds,result.followups) : await queue.defer(delivery, result.delaySeconds); state = 'deferred';
        }
        stats[owned ? state : 'stale']++;
        return {state: owned ? state : 'stale',...context,...(result.reason?{reason:result.reason}:{})};
      } catch (error) {
        const details=diagnostic(error,{...context,operation:'dispatch'});
        lastError={at:new Date(now()).toISOString(),...details};
        if (signal.aborted) {
          // Cleanup may have uncertain external effects; let the receipt expire.
          stats.deferred++;
          return {state: 'interrupted',...context,diagnostic:details};
        }
        stats.errors++;
        if (error?.statusCode === 503) {
          const owned = await queue.defer(delivery, 300);
          stats[owned ? 'deferred' : 'stale']++;
          return {state: owned ? 'deferred' : 'stale', reason: 'configuration_unavailable',...context,diagnostic:details};
        }
        const result = await queue.failDelivery(delivery);
        stats[result.kind === 'retry' ? 'deferred' : result.kind === 'terminal' ? 'terminal' : 'stale']++;
        return {state: result.kind, reason: 'delivery_failed',...context,diagnostic:details};
      }
    });
    if (admission?.status === 'DEFERRED') return {state: 'admission_deferred', reason: admission.reason};
    return admission;
  }

  function tick() {
    if (activeTick) return Promise.resolve({state: 'busy'});
    activeTick = performTick().then(result=>{
      if(result.state==='completed') lastCompletedAt=new Date(now()).toISOString();
      return result;
    }).finally(() => { activeTick = null; });
    return activeTick;
  }
  async function run() {
    await queue.assertReady();
    while (!stop.signal.aborted) {
      let result;
      try { result = await tick(); }
      catch(error) { stats.errors++; const details=diagnostic(error,{operation:'poll'});
        lastError={at:new Date(now()).toISOString(),...details};result = {state: 'unavailable',diagnostic:details}; }
      consecutiveUnavailable=result.state==='unavailable'?consecutiveUnavailable+1:0;
      // Reporter receives bounded status only, never exceptions or message payloads.
      try { report(result); } catch { /* Metrics must not stop delivery. */ }
      const empty = ['idle', 'unavailable', 'admission_deferred', 'busy'].includes(result.state);
      idleStreak = empty ? Math.min(4, idleStreak + 1) : 0;
      const waitMs = empty ? Math.min(30000, 5000 * 2 ** (idleStreak - 1)) + Math.floor(random() * 500) : 0;
      if (stop.signal.aborted) break;
      try { await pause(waitMs, undefined, {signal: stop.signal}); } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
    }
  }
  return {
    tick,
    start() {
      if (!enabled || stop.signal.aborted) return null;
      if (!loop) loop = run();
      return loop;
    },
    stop() { stop.abort(); },
    async drain() { await Promise.all([loop, activeTick].filter(Boolean)); },
    status() { return {enabled, restrictedTrial:Boolean(trial), stopped: stop.signal.aborted, active: Boolean(activeTick), healthy: consecutiveUnavailable<3, consecutiveUnavailable,
      startedAt,lastPollAt,lastCompletedAt,lastError,...stats}; }
  };
}
