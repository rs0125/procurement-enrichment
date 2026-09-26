import { ImageRepository } from '../../models/images/repository.mjs';
import ProximityRepository from '../../models/proximity/repository.mjs';
import { geocodeRepository } from '../../models/geocode/singleRepository.mjs';
import { warmUpSession } from '../../lib/googleMaps/session.mjs';
import { extractCoordinatesFromUrl } from '../../lib/googleMaps/extractor.mjs';
import cache from '../../lib/images/imageCacheInvalidation.cjs';
import categories from '../../lib/proximity/proximityCategories.cjs';
import { createStorage,storageConfigured } from '../../lib/images/storage.mjs';
import { createExecutor,positiveId } from '../../lib/runtime/executor.mjs';
import { createImageLabelService } from './imageLabel.mjs';
import { createDocumentKindService } from './documentKind.mjs';
import { createWebsiteApprovalService } from './websiteApproval.mjs';
import { createWebpService } from './webp.mjs';
import { createJpegService } from './jpeg.mjs';
import { createGeocodeService } from './geocode.mjs';
import { createProximityService } from './proximity.mjs';
import { ProximityComputer } from './proximityCompute.mjs';

export const SERVICE_INPUTS=Object.freeze({geocode:'warehouseId',proximity:'warehouseId',
  'image-label':'imageId','document-kind':'imageId','website-approval':'imageId',webp:'imageId',jpeg:'imageId'});

export function createEnrichmentServices({prisma,executor=createExecutor()}={}) {
  const repository=new ImageRepository(prisma), proximity=new ProximityRepository(prisma);
  const shared={repository,invalidate:cache.invalidateImageCache};
  let store;
  const compression={...shared,configured:storageConfigured,getStore:()=>store ??= createStorage()};
  const handlers={
    geocode:createGeocodeService({repository:geocodeRepository(prisma),extract:extractCoordinatesFromUrl,warmUp:warmUpSession}),
    proximity:createProximityService({model:proximity,computer:new ProximityComputer(proximity),
      expectedRegions:ProximityRepository.expectedRegionsFor(categories.CATEGORIES.map(c=>c.key),120,{hospital:30})}),
    'image-label':createImageLabelService(shared),
    'document-kind':createDocumentKindService(shared),
    'website-approval':createWebsiteApprovalService(shared),
    webp:createWebpService(compression),jpeg:createJpegService(compression)
  };
  const shutdown=new AbortController();
  return {
    list:()=>Object.entries(SERVICE_INPUTS).map(([name,input])=>({name,input})),
    stop:()=>shutdown.abort(),
    async run(name,input={}) {
      if(!Object.hasOwn(SERVICE_INPUTS,name)) {const error=new Error('Unknown enrichment service');error.statusCode=404;throw error;}
      const field=SERVICE_INPUTS[name];
      positiveId(input[field]);
      if(Object.keys(input).some(key=>![field,'dryRun','signal'].includes(key)) || (input.dryRun!==undefined && typeof input.dryRun!=='boolean')) {
        const error=new Error('Invalid enrichment input');error.statusCode=400;throw error;
      }
      const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(180000),...(input.signal?[input.signal]:[])]);
      signal.throwIfAborted();
      if(input.dryRun) return handlers[name]({...input,signal});
      return executor(async()=>{
        const started=Date.now();
        let result;
        try {result=await handlers[name]({...input,signal});}
        catch(error) {
          await prisma.cronRunLog.create({data:{jobName:`enrichment:${name}`,status:'FAILED',durationMs:Date.now()-started,
            metadata:{[field]:input[field]},notes:'Enrichment execution failed'}}).catch(()=>{});
          throw error;
        }
        try {await prisma.cronRunLog.create({data:{jobName:`enrichment:${name}`,status:result.status,durationMs:Date.now()-started,
          metadata:{[field]:input[field],...result}}});}
        catch {result.warning='Audit logging deferred';}
        return result;
      });
    }
  };
}
