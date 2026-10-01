import { Router } from "express";
import { prisma, pool } from "../config/prisma.mjs";
import { cronRoutes } from "./cron.routes.mjs";
import { requireCronAuth } from '../middlewares/requireCronAuth.mjs';
import { createEnrichmentServices } from '../services/enrichment/index.mjs';
import { enrichmentRoutes } from './enrichment.routes.mjs';
import { createCronJobs } from '../services/cron/index.mjs';
import { sweepRoutes } from './sweeps.routes.mjs';
import { healthController } from '../controllers/health.controller.mjs';

import { createExecutor } from '../lib/runtime/executor.mjs';
import { QueueRepository } from '../models/queue/repository.mjs';
import { queueSettings } from '../lib/queue/settings.mjs';
import { createQueueRuntime } from '../services/queue/runtime.mjs';
import { createDeliveryServices } from '../services/queue/deliveryServices.mjs';
let memoryLimitHandler=()=>{};
export function onMemoryLimit(handler) { memoryLimitHandler=handler; }
const settings=queueSettings(process.env), queue=new QueueRepository(pool),
  executor=createExecutor({onMemoryLimit:()=>memoryLimitHandler()});
const actions=createEnrichmentServices({prisma,executor});
export const enrichments=createDeliveryServices({services:actions,queue,settings});
export const cronJobs=createCronJobs({prisma,services:enrichments,settings,queue});
export const queueRuntime=createQueueRuntime({prisma,queue,services:actions,settings,execute:executor});

const router = Router();

router.get('/health', (req,res,next)=>queueRuntime.status().healthy?next():res.status(503).json({status:'unhealthy'}), healthController(prisma));
router.get('/queue/status',requireCronAuth,async(req,res)=>res.json({runtime:queueRuntime.status(),...(settings.mode==='cron'?{}:{queue:await queue.stats()})}));

router.use("/cron", cronRoutes({ jobs: cronJobs, authorize: requireCronAuth }));
router.use(sweepRoutes({ jobs: cronJobs, authorize: requireCronAuth }));
router.use('/enrichment', enrichmentRoutes({ services: enrichments, authorize: requireCronAuth }));

export default router;
