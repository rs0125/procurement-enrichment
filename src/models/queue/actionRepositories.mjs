import { ImageRepository } from '../images/repository.mjs';
import ProximityRepository from '../proximity/repository.mjs';
import { geocodeRepository } from '../geocode/singleRepository.mjs';
import jpeg from '../../lib/images/jpegPolicy.cjs';

export class QueueImageRepository extends ImageRepository {
  constructor(prisma,context) {super(prisma); this.context=context;}
  claim(...args) {return this.context.mutate(tx=>new ImageRepository(tx).claim(...args),{fallback:[]});}
  complete(...args) {return this.context.mutate(tx=>new ImageRepository(tx).complete(...args));}
  fail(...args) {return this.context.mutate(tx=>new ImageRepository(tx).fail(...args),{cleanup:true});}
  projectLegacy(id) {return this.context.mutate(tx=>new ImageRepository(tx).projectLegacy(id));}
  publishJpeg(_prisma,row,result) {return this.context.mutate(async tx=>{
    const saved=await jpeg.publish(tx,row,result);
    if(saved) await this.context.finishInTransaction(tx,'SUCCESS');
    return saved;
  });}
}
export function queueGeocodeRepository(prisma,context) {
  const invoke=method=>(row,result)=>context.mutate(async tx=>{
    const saved=await geocodeRepository(tx,{inTransaction:true,attemptReserved:true})[method](row,result);
    if(saved) await context.finishInTransaction(tx,method==='publish'?'SUCCESS':'FAILED');
    return saved;
  });
  return {get:async()=>context.source,publish:invoke('publish'),fail:invoke('fail')};
}
export class QueueProximityRepository extends ProximityRepository {
  constructor(prisma,context) {super(prisma);this.context=context;}
  bounded(method,...args) {
    if(method==='warehousesToCompute') return Promise.resolve([{id:this.context.source.id,lat:this.context.source.latitude,lng:this.context.source.longitude}]);
    return super.bounded(method,...args);
  }
  upsertCurrent(warehouse,rows) {return this.context.mutate(async tx=>{
    const saved=await new ProximityRepository(tx).upsertMany(warehouse.id,rows,{onlyMissingOrStale:true});
    if(saved) await this.context.finishInTransaction(tx,'SUCCESS');
    return saved;
  });}
}
