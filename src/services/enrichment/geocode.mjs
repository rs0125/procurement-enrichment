import { positiveId } from '../../lib/runtime/executor.mjs';

export function createGeocodeService({repository,extract,warmUp}) {
  return async({warehouseId,dryRun=false,signal})=>{
    positiveId(warehouseId);
    const row=await repository.get(warehouseId);
    if(!row) return {status:'SKIPPED',reason:'warehouse_not_found',warehouseId};
    if(dryRun) return {status:'DRY_RUN',warehouseId,pending:Boolean(row.googleLocation && (row.latitude==null || row.longitude==null))};
    if(!row.googleLocation || (row.latitude!=null && row.longitude!=null)) return {status:'SKIPPED',reason:'coordinates_present_or_no_url',warehouseId};
    signal?.throwIfAborted();
    try {await warmUp({signal});} catch {signal?.throwIfAborted();}
    let result;
    try { result=await extract(row.googleLocation,{signal}); }
    catch { signal?.throwIfAborted(); result={lat:null,lng:null,via:'error_thrown'}; }
    signal?.throwIfAborted();
    if(!Number.isFinite(result.lat) || !Number.isFinite(result.lng) || Math.abs(result.lat)>90 || Math.abs(result.lng)>180) {
      const saved=await repository.fail(row,result);
      return {status:saved?'FAILED':'STALE',reason:'coordinates_not_found',warehouseId};
    }
    const saved=await repository.publish(row,result);
    return {status:saved?'READY':'STALE',warehouseId};
  };
}
