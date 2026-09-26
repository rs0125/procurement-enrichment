import { createHash } from 'node:crypto';
import { imageStage } from './imageStage.mjs';
import { download,decode,withTemporaryFiles,validateSource } from '../../lib/images/files.mjs';

export const WEBP_VERSION='sharp-w1280-q75-v1';
export function createWebpService(deps) {
  return imageStage('webp',{...deps,processImage:async(row,{signal})=>{
    const store=deps.getStore();
    validateSource(row.imageUrl,store.publicBase);
    const generated=`webp/images/${createHash('sha256').update(row.imageUrl).digest('hex')}/${WEBP_VERSION}.webp`;
    let key=generated,metadata;
    if(row.webpObjectKey) {
      metadata=await store.head(row.webpObjectKey,signal);
      if(metadata) key=row.webpObjectKey;
    }
    if(!metadata) metadata=await store.head(generated,signal);
    if(!metadata) metadata=await (deps.temporary ?? withTemporaryFiles)(async(input,output)=>{
      await (deps.download ?? download)(row.imageUrl,input,store.publicBase,signal);
      await (deps.decode ?? decode)(input,output,'webp',1280,signal);
      return store.put(generated,output,'webp',signal);
    });
    return {storageBucket:store.bucket,originalObjectKey:decodeURIComponent(new URL(row.imageUrl).pathname).replace(/^\/+/,''),
      webpUrl:store.url(key),webpObjectKey:key,webpBytes:metadata.bytes,webpAt:metadata.modifiedAt,
      webpVersion:key===generated ? WEBP_VERSION : row.webpVersion};
  }});
}
