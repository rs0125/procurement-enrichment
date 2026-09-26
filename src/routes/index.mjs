import { Router } from "express";
import { prisma } from "../config/prisma.mjs";
import cronRoutes from "./cron.routes.mjs";
import { requireCronAuth } from '../middlewares/requireCronAuth.mjs';
import { createEnrichmentServices } from '../services/enrichment/index.mjs';
import { enrichmentRoutes } from './enrichment.routes.mjs';

export const enrichments = createEnrichmentServices({ prisma });

const router = Router();

router.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    res.status(503).json({ status: "error", db: err.message });
  }
});

router.use("/cron", cronRoutes);
router.use('/enrichment', enrichmentRoutes({ services: enrichments, authorize: requireCronAuth }));

export default router;
