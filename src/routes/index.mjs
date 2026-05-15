import { Router } from "express";
import { prisma } from "../config/prisma.mjs";
import cronRoutes from "./cron.routes.mjs";

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

export default router;
