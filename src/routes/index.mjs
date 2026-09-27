import { Router } from "express";
import { prisma } from "../config/prisma.mjs";
import cronRoutes from "./cron.routes.mjs";
import { requireCronAuth } from '../middlewares/requireCronAuth.mjs';
import { createEnrichmentServices } from '../services/enrichment/index.mjs';
import { enrichmentRoutes } from './enrichment.routes.mjs';
import { createCronJobs } from '../services/cron/index.mjs';
import { sweepRoutes } from './sweeps.routes.mjs';
import { healthController } from '../controllers/health.controller.mjs';

export const enrichments = createEnrichmentServices({ prisma });
export const cronJobs = createCronJobs({ prisma, services: enrichments });

const router = Router();

router.get('/health', healthController(prisma));

router.use("/cron", cronRoutes);
router.use(sweepRoutes({ jobs: cronJobs, authorize: requireCronAuth }));
router.use('/enrichment', enrichmentRoutes({ services: enrichments, authorize: requireCronAuth }));

export default router;
