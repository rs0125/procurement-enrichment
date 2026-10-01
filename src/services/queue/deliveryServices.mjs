import { SERVICE_INPUTS } from '../enrichment/index.mjs';
import { positiveId } from '../../lib/runtime/executor.mjs';
import { request } from '../../lib/queue/contract.mjs';

export function createDeliveryServices({services,queue,settings}) {
  async function deliver(name,input={},reconcile=false) {
    const field=SERVICE_INPUTS[name];
    if(!field) {const e=new Error('Unknown enrichment service');e.statusCode=404;throw e;}
    positiveId(input[field]);
    if(Object.keys(input).some(k=>![field,'dryRun','signal'].includes(k)) || input.dryRun!==undefined && typeof input.dryRun!=='boolean') {
      const e=new Error('Invalid enrichment input');e.statusCode=400;throw e;
    }
    input.signal?.throwIfAborted();
    if(input.dryRun) return services.run(name,input);
    if(settings.role==='api') {const e=new Error('Processing disabled on API-only process');e.statusCode=503;throw e;}
    if(settings.mode!=='queue') return services.run(name,input);
    // Explicit requests are independent intents, even while an older job is
    // finishing. Only periodic repair may coalesce an already-pending job.
    const item=await queue[reconcile?'ensurePending':'enqueue'](request(name,input[field]));
    return {status:'QUEUED',messageId:item.messageId,[field]:input[field]};
  }
  return {deliveryMode:settings.mode,list:()=>services.list(),stop:()=>services.stop(),
    run:(name,input)=>deliver(name,input),reconcile:(name,input)=>deliver(name,input,true)};
}
