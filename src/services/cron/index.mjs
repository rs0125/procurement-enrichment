import { CronRunRepository } from '../../models/cron/runRepository.mjs';
import { CronImageRepository } from '../../models/cron/imageRepository.mjs';
import ProximityRepository from '../../models/proximity/repository.mjs';
import { createStorage, storageConfigured } from '../../lib/images/storage.mjs';
import cache from '../../lib/images/imageCacheInvalidation.cjs';
import { createScheduledJob } from './scheduledJob.mjs';
import { createEnrichmentSweep } from './enrichmentSweep.mjs';
import { createWebpSweep } from './webpSweep.mjs';

export function createCronJobs({ prisma, services }) {
  const repository = new CronImageRepository(prisma), runLog = new CronRunRepository(prisma);
  const shutdown = new AbortController();
  const enrichment = createEnrichmentSweep({ repository, runLog, services, proximity: new ProximityRepository(prisma),
    configured: () => ({ images: Boolean(process.env.OPENAI_API_KEY), websiteImages: Boolean(process.env.OPENAI_API_KEY),
      proximity: Boolean(process.env.MAPBOX_ACCESS_TOKEN) }) });
  let store;
  const webp = createWebpSweep({ repository, services, getStore: () => store ??= createStorage(),
    configured: storageConfigured, invalidate: cache.invalidateImageCache });
  const jobs = {
    enrichment: createScheduledJob({ ...enrichment, runLog, jobName: 'sweep_warehouse_enrichment', budgetMs: 10 * 60000, shutdownSignal: shutdown.signal }),
    webp: createScheduledJob({ ...webp, runLog, jobName: 'sweep_warehouse_webp', budgetMs: 45 * 60000, shutdownSignal: shutdown.signal }),
  };
  return { ...jobs, stop: () => shutdown.abort(), drain: () => Promise.all(Object.values(jobs).map(job => job.drain())) };
}
