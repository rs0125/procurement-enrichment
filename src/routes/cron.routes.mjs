import { Router } from 'express';
import { sweepController } from '../controllers/cron/sweep.controller.mjs';

export function cronRoutes({ jobs, authorize }) {
  const router = Router(), controller = sweepController(jobs.geocode);
  router.post('/geocode-recent', authorize, controller.start);
  router.get('/geocode-recent', authorize, controller.status);
  return router;
}
