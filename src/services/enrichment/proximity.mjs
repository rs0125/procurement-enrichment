import categoriesModule from '../../lib/proximity/proximityCategories.cjs';
import { positiveId } from '../../lib/runtime/executor.mjs';
const { CATEGORIES }=categoriesModule;

export function createProximityService({model,computer,expectedRegions}) {
  return async({warehouseId,dryRun=false,signal})=>{
    positiveId(warehouseId);
    const [warehouse]=await model.bounded('warehousesToCompute',{ids:[warehouseId],limit:1});
    if(!warehouse) return {status:'SKIPPED',reason:'coordinates_required',warehouseId};
    const [coverage,stored]=await Promise.all([model.bounded('coverage',expectedRegions),model.bounded('rowsFor',warehouseId)]);
    const skippedCategories=coverage.filter(c=>!c.complete).map(c=>c.category);
    const needed=CATEGORIES.filter(c=>!skippedCategories.includes(c.key) && !stored.some(row=>row.category===c.key
      && row.computedFromLat===warehouse.lat && row.computedFromLng===warehouse.lng));
    if(dryRun) return {status:'DRY_RUN',warehouseId,pendingCategories:needed.map(c=>c.key),skippedCategories};
    if(!needed.length) return {status:skippedCategories.length?'DEFERRED':'SKIPPED',reason:skippedCategories.length?'coverage_incomplete':'already_current',warehouseId,skippedCategories};
    if(!process.env.MAPBOX_ACCESS_TOKEN) {const error=new Error('Service configuration missing');error.statusCode=503;throw error;}
    signal?.throwIfAborted();
    const watermarks=await model.bounded('poiWatermarks');
    const rows=await computer.compute(warehouse,needed,watermarks,signal);
    signal?.throwIfAborted();
    const saved=await model.upsertCurrent(warehouse,rows);
    return {status:saved ? skippedCategories.length?'PARTIAL':'READY' : 'STALE',warehouseId,rows:saved,skippedCategories};
  };
}
