import { createHash } from 'node:crypto';
import { receipt } from '../../lib/queue/contract.mjs';
import { GEOCODE_ELIGIBILITY_SQL } from '../geocode/eligibility.mjs';
import { COORDINATE_EPSILON, sameCoordinates } from '../../lib/proximity/coordinates.mjs';

export const secondsUntil = (value, fallback = 300) => {
  const time = value==null ? NaN : new Date(value).getTime();
  return Number.isFinite(time) ? Math.max(1, Math.min(604800, Math.ceil((time-Date.now())/1000))) : fallback;
};
export const waitFor = (reason, value, fallback) => ({kind:'defer', reason, delaySeconds:secondsUntil(value, fallback)});

// A queue delivery is only permission to try. Source rows, stage/attempt ownership
// and the queue receipt must all still match in the publication transaction.
export class QueueActionContext {
  constructor({prisma, action, source, delivery}) {
    Object.assign(this, {prisma, action, source, signal:delivery.signal, owner:receipt(delivery.receipt)});
    this.image = !['geocode','proximity'].includes(action);
    const fields = this.image ? [source.imageUrl,source.classification] : action==='geocode'
      ? [source.googleLocation,source.latitude,source.longitude] : [source.latitude,source.longitude];
    this.sourceHash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  }
  async lockSource(tx) {
    const s=this.source;
    if(this.image) {
      const refs=await tx.$queryRawUnsafe(`SELECT id FROM "Warehouse" WHERE $1=ANY(public.wareongo_image_urls(media::jsonb,photos)) ORDER BY id FOR UPDATE`,s.imageUrl);
      if(!refs.length) return false;
      const [row]=await tx.$queryRawUnsafe('SELECT * FROM labeled_warehouse_images WHERE id=$1 FOR UPDATE',s.id);
      return row?.imageUrl===s.imageUrl
        && (!['jpeg','document-kind','image-label'].includes(this.action) || row.classification===s.classification)
        && (this.action!=='website-approval' || JSON.stringify(row.websiteOverride)===JSON.stringify(s.websiteOverride));
    }
    const [w]=await tx.$queryRawUnsafe('SELECT id,"googleLocation" FROM "Warehouse" WHERE id=$1 FOR UPDATE',s.id);
    if(!w || this.action==='geocode' && w.googleLocation!==s.googleLocation) return false;
    const [d]=await tx.$queryRawUnsafe('SELECT latitude,longitude FROM "WarehouseData" WHERE "warehouseId"=$1 FOR UPDATE',s.id);
    return ['latitude','longitude'].every(key => this.action==='proximity'
      ? d?.[key]!=null && s[key]!=null && Math.abs(d[key]-s[key])<=COORDINATE_EPSILON
      : (d?.[key]??null)===(s[key]??null));
  }
  async mutate(work,{fallback=0,cleanup=false,requireAttempt=true}={}) {
    if(!cleanup) this.signal?.throwIfAborted();
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1s'");
      if(!await this.lockSource(tx)) return fallback;
      if(requireAttempt && this.attempt) {
        const [attempt]=await tx.$queryRawUnsafe('SELECT status,metadata FROM "CronRunLog" WHERE id=$1 FOR UPDATE',this.attempt.id);
        if(attempt?.status!=='RUNNING' || new Date(attempt.metadata.leaseUntil).getTime()<=Date.now()
          || attempt.metadata.queueMessageId!==this.owner.msg_id || attempt.metadata.queueReadCount!==this.owner.read_ct) return fallback;
      }
      const [owned]=await tx.$queryRawUnsafe('SELECT enrichment.owns_receipt($1::bigint,$2::int) AS owned',this.owner.msg_id,this.owner.read_ct);
      if(!owned.owned) return fallback;
      if(!cleanup) this.signal?.throwIfAborted();
      const result=await work(tx);
      if(!cleanup) this.signal?.throwIfAborted();
      return result;
    },{maxWait:3000,timeout:8000});
  }
  reserve() {
    if(!['geocode','proximity','jpeg'].includes(this.action)) return Promise.resolve(null);
    return this.mutate(async tx=>{
      const jobName=this.action==='proximity' ? `warehouse_proximity:${this.source.id}` : `queue_${this.action}:${this.source.id}`;
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',jobName);
      const [prior]=await tx.$queryRawUnsafe('SELECT * FROM "CronRunLog" WHERE "jobName"=$1 ORDER BY "ranAt" DESC,id DESC LIMIT 1',jobName);
      const same=prior?.metadata?.sourceHash===this.sourceHash || this.action==='proximity'
        && sameCoordinates({computedFromLat:prior?.metadata?.lat,computedFromLng:prior?.metadata?.lng},
          {lat:this.source.latitude,lng:this.source.longitude});
      const meta=same ? prior.metadata : {};
      if(same && prior.status==='RUNNING') {
        const lease=meta.leaseUntil ?? new Date(new Date(prior.ranAt).getTime()+900000);
        if(new Date(lease).getTime()>Date.now()) return waitFor('stage_claimed',lease);
      }
      const attempts=same && prior.status!=='SUCCESS' ? Number(meta.attempts)||0 : 0;
      if(this.action==='jpeg' && same && (prior.status==='UNSUPPORTED' || attempts>=5)) return {kind:'terminal',reason:prior.status==='UNSUPPORTED'?'unsupported_source':'attempts_exhausted'};
      if(same && prior.status!=='SUCCESS' && new Date(meta.retryAt).getTime()>Date.now()) return waitFor('retry_cooldown',meta.retryAt);
      if(this.action==='geocode') {
        const [row]=await tx.$queryRawUnsafe(`SELECT (${GEOCODE_ELIGIBILITY_SQL}) AS eligible FROM "Warehouse" w
          LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id LEFT JOIN "GeocodeAttempt" a ON a."warehouseId"=w.id WHERE w.id=$1`,this.source.id);
        if(!row.eligible) return waitFor('geocode_not_eligible',null,86400);
        await tx.geocodeAttempt.upsert({where:{warehouseId:this.source.id},create:{warehouseId:this.source.id,attemptCount:1},update:{attemptCount:{increment:1}}});
      }
      const count=attempts+1, now=Date.now();
      this.attempt=await tx.cronRunLog.create({data:{jobName,status:'RUNNING',durationMs:0,metadata:{sourceHash:this.sourceHash,
        attempts:count,queueMessageId:this.owner.msg_id,queueReadCount:this.owner.read_ct,
        leaseUntil:new Date(now+300000).toISOString(),retryAt:new Date(now+(this.action==='geocode'?86400000:
          Math.min(this.action==='proximity'?21600000:86400000,(this.action==='proximity'?900000:300000)*2**Math.min(count-1,8)))).toISOString(),
        ...(this.action==='proximity'?{lat:this.source.latitude,lng:this.source.longitude}:{})}}});
      return null;
    },{fallback:{kind:'defer',reason:'source_or_receipt_changed',delaySeconds:30},requireAttempt:false});
  }
  async finishInTransaction(tx,status) {
    if(!this.attempt) return;
    await tx.cronRunLog.update({where:{id:this.attempt.id},data:{status}});
    if(this.action==='jpeg' && ['FAILED','UNSUPPORTED'].includes(status)) await tx.$executeRawUnsafe(
      `UPDATE labeled_warehouse_images SET "jpegStatus"=$2,"jpegError"='processing_failed' WHERE id=$1 AND "jpegStatus"<>'READY'`,this.source.id,status);
  }
  finish(status) {return this.attempt ? this.mutate(tx=>this.finishInTransaction(tx,status),{cleanup:true}) : Promise.resolve();}
}
