import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sweepController } from '../controllers/cron/sweep.controller.mjs';

export function compressionAuth(secret = () => process.env.R2_SECRET_ACCESS_KEY) {
  return (req, res, next) => {
    const key = secret()?.trim();
    if (!key) return res.status(503).json({ error: 'compression_not_configured' });
    const expected = Buffer.from(createHmac('sha256', key).update('wareongo:warehouse-webp-trigger:v1').digest('hex'));
    const provided = Buffer.from(/^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
}

export function sweepRoutes({ jobs, authorize }) {
  const router = Router();
  for (const name of ['enrichment', 'webp']) {
    const controller = sweepController(jobs[name]);
    router.post(`/cron/${name}`, authorize, controller.start);
    router.get(`/cron/${name}`, authorize, controller.status);
  }
  const webp = sweepController(jobs.webp);
  router.post('/maintenance/webp', compressionAuth(), webp.start);
  router.get('/maintenance/webp', compressionAuth(), webp.status);
  return router;
}
