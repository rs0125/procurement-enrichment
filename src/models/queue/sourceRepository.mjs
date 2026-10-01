import { subjectId } from '../../lib/queue/contract.mjs';
import { QueueRepository } from './repository.mjs';
import { GEOCODE_ELIGIBILITY_SQL } from '../geocode/eligibility.mjs';

export const MAX_PREVIEW_IMAGES = 200;
const stageColumns = ['label','document','website','webp'].flatMap(stage =>
  ['Status','Attempts','LeaseUntil','NextAttemptAt'].map(suffix => `l."${stage}${suffix}"`));

export class QueueSourceRepository {
  constructor(pool) { this.database = new QueueRepository(pool); }
  snapshot(id) {
    id = subjectId(id);
    return this.database.transaction(async client => {
      const {rows: [warehouse]} = await client.query(`SELECT w.id,w.visibility,d.latitude,d.longitude,
        (${GEOCODE_ELIGIBILITY_SQL}) AS "geocodeEligible",
        a."attemptCount" AS "geocodeAttempts",
        now() AS "checkedAt"
        FROM public."Warehouse" w
        LEFT JOIN public."WarehouseData" d ON d."warehouseId"=w.id
        LEFT JOIN public."GeocodeAttempt" a ON a."warehouseId"=w.id WHERE w.id=$1::int`, [id]);
      if (!warehouse) return null;
      const {rows: images} = await client.query(`SELECT u.ordinality AS position,l.id,l."imageUrl",
        l.classification,l."documentKind",l."jpegStatus",l."jpegUrl",l."jpegVersion",
        l."websiteOverride" IS NOT NULL AS "hasWebsiteOverride",${stageColumns.join(',')}
        FROM public."Warehouse" w CROSS JOIN LATERAL
          unnest(public.wareongo_image_urls(w.media::jsonb,w.photos)) WITH ORDINALITY u(url,ordinality)
        LEFT JOIN public.labeled_warehouse_images l ON l."imageUrl"=u.url
        WHERE w.id=$1::int ORDER BY u.ordinality LIMIT $2`, [id, MAX_PREVIEW_IMAGES + 1]);
      return {warehouse, images: images.slice(0, MAX_PREVIEW_IMAGES), oversized: images.length > MAX_PREVIEW_IMAGES};
    }, {readOnly: true});
  }
}
