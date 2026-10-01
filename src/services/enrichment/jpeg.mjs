import jpeg from '../../lib/images/jpegPolicy.cjs';
import { positiveId } from '../../lib/runtime/executor.mjs';
import { download,decode,withTemporaryFiles } from '../../lib/images/files.mjs';

export function createJpegService(deps) {
  return async({imageId,dryRun=false,signal})=>{
    positiveId(imageId);
    const row=await deps.repository.getActive(imageId);
    if(!row) return {status:'SKIPPED',reason:'image_not_referenced',imageId};
    if(dryRun) return {status:'DRY_RUN',imageId,stage:'jpeg',currentStatus:row.jpegStatus,configured:deps.configured()};
    if(jpeg.complete(row)) return {status:'SKIPPED',reason:'already_ready',imageId};
    if(!row.classification) return {status:'DEFERRED',reason:'label_required',imageId};
    if(!deps.configured()) {const error=new Error('Service configuration missing');error.statusCode=503;throw error;}
    signal?.throwIfAborted();
    const store=deps.getStore();
    let result;
    try {
      result=await (deps.temporary ?? withTemporaryFiles)(async(input,output)=>{
        const source=await (deps.download ?? download)(row.imageUrl,input,store.publicBase,signal);
        const inspect=await (deps.decode ?? decode)(input,output,'inspect',jpeg.maxEdge(row),signal);
        if(jpeg.reusable(inspect.metadata,source.bytes,jpeg.maxEdge(row),row.imageUrl)) {
          return {url:row.imageUrl,bytes:source.bytes,version:jpeg.REUSE_VERSION};
        }
        const target=jpeg.targetFor(row,source.hash,store.publicBase);
        let metadata=await store.head(target.key,signal);
        if(!metadata) {
          await (deps.decode ?? decode)(input,output,'jpeg',jpeg.maxEdge(row),signal);
          metadata=await store.put(target.key,output,'jpeg',signal);
        }
        return {url:target.url,bytes:metadata.bytes,version:jpeg.versionFor(row)};
      });
      signal?.throwIfAborted();
    } catch(error) {
      return {status:signal?.aborted || error.code==='memory_pressure' ? 'DEFERRED' : error.unsupported ? 'UNSUPPORTED' : 'FAILED',imageId,reason:'processing_failed'};
    }
    const saved=await (deps.publish ?? jpeg.publish)(deps.repository.prisma,row,result);
    if(saved) await deps.invalidate();
    return {status:saved?'READY':'STALE',imageId,reusedOriginal:result.url===row.imageUrl};
  };
}
