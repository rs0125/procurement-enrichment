import { Router } from "express";
import { requireCronAuth } from "../middlewares/requireCronAuth.mjs";
import { geocodeRecent } from "../controllers/cron/geocodeRecent.controller.mjs";

const router = Router();

router.post("/geocode-recent", requireCronAuth, geocodeRecent);

export default router;
