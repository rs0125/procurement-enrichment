import { CronRunRepository } from '../../models/cron/runRepository.mjs';
import { CronImageRepository } from '../../models/cron/imageRepository.mjs';
import ProximityRepository from '../../models/proximity/repository.mjs';
import { createStorage, storageConfigured } from '../../lib/images/storage.mjs';
import cache from '../../lib/images/imageCacheInvalidation.cjs';
import { createScheduledJob } from './scheduledJob.mjs';
import { createEnrichmentSweep } from './enrichmentSweep.mjs';
import { geocodeCandidates } from '../../models/geocode/attemptRepo.mjs';
import { createGeocodeRecentSweep } from './geocodeRecent.service.mjs';
import { createWebpSweep } from './webpSweep.mjs';

export function createCronJobs({ prisma, services, settings={mode:"cron",role:"worker"}, queue }) {
  const repository = new CronImageRepository(prisma), runLog = new CronRunRepository(prisma);
  const shutdown = new AbortController();
  const enrichment = createEnrichmentSweep({ repository, runLog, services, proximity: new ProximityRepository(prisma),
    configured: () => ({ images: Boolean(process.env.OPENAI_API_KEY), websiteImages: Boolean(process.env.OPENAI_API_KEY),
      proximity: Boolean(process.env.MAPBOX_ACCESS_TOKEN) }) });
  if(settings.mode==='queue') {
    const work=enrichment.work;
    enrichment.work=async input=>{const result=await work(input);result.prunedArchive=await queue.pruneArchive();return result;};
  }
  let store;
  const webp = createWebpSweep({ repository, services, getStore: () => store ??= createStorage(),
    configured: storageConfigured, invalidate: cache.invalidateImageCache });
  const geocode = createGeocodeRecentSweep({ repository: geocodeCandidates(prisma), services });
  const jobs = {
    geocode: createScheduledJob({ ...geocode, runLog, jobName: 'geocode-recent', budgetMs: 10 * 60000, shutdownSignal: shutdown.signal }),
    enrichment: createScheduledJob({ ...enrichment, runLog, jobName: 'sweep_warehouse_enrichment', budgetMs: 10 * 60000, shutdownSignal: shutdown.signal }),
    webp: createScheduledJob({ ...webp, runLog, jobName: 'sweep_warehouse_webp', budgetMs: 45 * 60000, shutdownSignal: shutdown.signal }),
  };
  if(settings.role==='api') for(const job of Object.values(jobs)) job.start=()=>{
    const error=new Error('Processing disabled on API-only process');error.statusCode=503;throw error;
  };
  return { ...jobs, stop: () => shutdown.abort(), drain: () => Promise.all(Object.values(jobs).map(job => job.drain())) };
}
