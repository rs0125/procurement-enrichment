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

import { QueueImageRepository, QueueProximityRepository, queueGeocodeRepository } from '../../models/queue/actionRepositories.mjs';

export const SERVICE_INPUTS=Object.freeze({geocode:'warehouseId',proximity:'warehouseId',
  'image-label':'imageId','document-kind':'imageId','website-approval':'imageId',webp:'imageId',jpeg:'imageId'});

export function createEnrichmentServices({prisma,executor=createExecutor(),providers={}}={}) {
  let store;
  const configured=name=>['webp','jpeg'].includes(name) ? (providers.storageConfigured??storageConfigured)()
    : ['image-label','document-kind','website-approval'].includes(name) ? (providers.imageConfigured??(()=>Boolean(process.env.OPENAI_API_KEY)))()
    : name==='proximity' ? Boolean(process.env.MAPBOX_ACCESS_TOKEN) : true;
  function handlersFor(context) {
    const repository=context?new QueueImageRepository(prisma,context):new ImageRepository(prisma);
    const proximity=context?new QueueProximityRepository(prisma,context):new ProximityRepository(prisma);
    const shared={repository,invalidate:providers.invalidate??cache.invalidateImageCache};
    const compression={...shared,configured:()=>configured('webp'),getStore:providers.getStore??(()=>store??=createStorage()),
      ...Object.fromEntries(['download','decode','temporary'].filter(k=>providers[k]).map(k=>[k,providers[k]]))};
    return {
      geocode:createGeocodeService({repository:context?queueGeocodeRepository(prisma,context):geocodeRepository(prisma),
        extract:providers.extract??extractCoordinatesFromUrl,warmUp:providers.warmUp??warmUpSession}),
      proximity:createProximityService({model:proximity,computer:providers.computer??new ProximityComputer(proximity),
        expectedRegions:providers.expectedRegions??ProximityRepository.expectedRegionsFor(categories.CATEGORIES.map(c=>c.key),120,{hospital:30})}),
      'image-label':createImageLabelService({...shared,configured:()=>configured('image-label'),classify:providers.classify}),
      'document-kind':createDocumentKindService({...shared,configured:()=>configured('document-kind'),classify:providers.classifyDocument}),
      'website-approval':createWebsiteApprovalService({...shared,configured:()=>configured('website-approval'),assess:providers.assess}),
      webp:createWebpService(compression),jpeg:createJpegService({...compression,...(context?{publish:repository.publishJpeg.bind(repository)}:{})})
    };
  }
  const handlers=handlersFor();
  const shutdown=new AbortController();
  return {
    configured,
    async runQueued(name,input,context) {
      if(!Object.hasOwn(SERVICE_INPUTS,name) || !context?.owner || context.action!==name) throw new Error('Queue context required');
      positiveId(input[SERVICE_INPUTS[name]]);
      context.signal=AbortSignal.any([shutdown.signal,context.signal]);
      context.signal.throwIfAborted();
      return handlersFor(context)[name]({...input,signal:context.signal});
    },
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
