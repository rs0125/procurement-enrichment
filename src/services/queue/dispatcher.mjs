import { setTimeout as delay } from 'node:timers/promises';
import { ImageRepository } from '../../models/images/repository.mjs';
import { QueueImageRepository } from '../../models/queue/actionRepositories.mjs';
import { QueueActionContext,waitFor } from '../../models/queue/actionContext.mjs';
import { GEOCODE_ELIGIBILITY_SQL } from '../../models/geocode/eligibility.mjs';
import { request } from '../../lib/queue/contract.mjs';
import { SERVICE_INPUTS } from '../enrichment/index.mjs';
import { imageReadiness } from './planner.mjs';

function geocodeReadiness(row) {
  if(row.latitude!=null && row.longitude!=null || !row.googleLocation || row.succeededAt) return {state:'done'};
  if(row.geocodeEligible) return {state:'eligible'};
  if(Number(row.attemptCount)>=5) return {state:'terminal',reason:'attempts_exhausted'};
  if(Math.max(new Date(row.createdAt).getTime(),new Date(row.status_updated_at??0).getTime())<Date.now()-7*86400000) return {state:'done'};
  return {state:'waiting',reason:'retry_cooldown',eligibleAt:new Date(new Date(row.lastAttemptAt).getTime()+86400000)};
}

export function createQueueDispatcher({prisma,services,refresh,pause=delay}) {
  const images=new ImageRepository(prisma);
  const warehouse=async id=>(await prisma.$queryRawUnsafe(`SELECT w.id,w."googleLocation",w."createdAt",w."status_updated_at",d.latitude,d.longitude,a."attemptCount",a."lastAttemptAt",a."succeededAt",
    (${GEOCODE_ELIGIBILITY_SQL}) AS "geocodeEligible" FROM "Warehouse" w LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id
    LEFT JOIN "GeocodeAttempt" a ON a."warehouseId"=w.id WHERE w.id=$1`,id))[0];
  return async (input,delivery)=>{
    if(input.action==='refresh-warehouse') return refresh(input,delivery);
    const {action,lane}=input,id=Number(input.subjectId),image=SERVICE_INPUTS[action]==='imageId';
    const read=()=>image?images.getActive(id):warehouse(id);
    let source=await read();
    if(!source) return {kind:'done'};
    const children=row=>action==='image-label' && row.classification==='DOCUMENT' ? [request('document-kind',id,lane)]
      : action==='geocode' && row.latitude!=null && row.longitude!=null ? [request('proximity',id,lane)] : [];
    const decide=row=>{
      if(image) return imageReadiness(action,row);
      if(action==='proximity') return row.latitude!=null && row.longitude!=null ? {state:'eligible'} : {state:'waiting',reason:'coordinates_required'};
      return geocodeReadiness(row);
    };
    const settle=async decision=>{
      if(decision.state==='done') return {kind:'done',followups:children(source)};
      if(decision.state==='terminal' || decision.state==='blocked') return {kind:'terminal',reason:decision.reason};
      const result=waitFor(decision.reason,decision.eligibleAt);
      if(decision.reason==='label_required') {
        const label=imageReadiness('image-label',source);
        if(label.state==='terminal' || label.state==='blocked') return {kind:'terminal',reason:'label_unavailable'};
        result.followups=[request('image-label',id,lane)];
      }
      if(decision.reason==='coordinates_required') {
        const prerequisite=geocodeReadiness(source);
        if(['terminal','done'].includes(prerequisite.state)) return {kind:'terminal',reason:'coordinates_unavailable'};
        if(prerequisite.state==='waiting') result.delaySeconds=waitFor('retry_cooldown',prerequisite.eligibleAt).delaySeconds;
        result.followups=[request('geocode',id,lane)];
      }
      return result;
    };
    const decision=decide(source);
    const context=new QueueActionContext({prisma,action,source,delivery});
    if(image && decision.reason==='attempts_exhausted' && action!=='jpeg') {
      const stage={'image-label':'label','document-kind':'document','website-approval':'website',webp:'webp'}[action];
      // Reuse the existing final-attempt recovery without starting provider work.
      if(source[`${stage}Status`]==='RUNNING') await new QueueImageRepository(prisma,context).claim(stage,{imageId:id,limit:1});
    }
    if(decision.state!=='eligible' && !(action==='webp' && decision.state==='done')) return settle(decision);
    if(!services.configured(action) && decision.state!=='done') return waitFor('configuration_unavailable',null,900);
    const args={[SERVICE_INPUTS[action]]:id};
    if(action==='proximity') {
      const preview=await services.runQueued(action,{...args,dryRun:true},context);
      if(!preview.pendingCategories.length) return preview.skippedCategories.length ? waitFor('coverage_incomplete',null,3600) : {kind:'done'};
    }
    const reserved=await context.reserve();
    if(reserved) return reserved;
    let result;
    try {result=await services.runQueued(action,args,context);}
    catch(error) {await context.finish('FAILED');throw error;}
    await context.finish(['READY','SKIPPED'].includes(result.status)?'SUCCESS':result.status==='UNSUPPORTED'?'UNSUPPORTED':'FAILED');
    if(action==='geocode') await pause(2000,undefined,{signal:delivery.signal});
    source=await read();
    if(!source) return {kind:'done'};
    if(action==='proximity' && ['READY','SKIPPED'].includes(result.status)) return {kind:'done'};
    if(action==='proximity') return waitFor(result.status==='PARTIAL'?'coverage_incomplete':'retry_cooldown',null,900);
    const after=decide(source);
    return after.state==='eligible' ? waitFor('retry_pending',null,300) : settle(after);
  };
}
