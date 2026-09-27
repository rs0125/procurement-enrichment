import { ImageRepository } from '../images/repository.mjs';

const stages = new Set(['label', 'document', 'website', 'webp']);
const missing = { label: 'l.classification IS NULL',
  document: `l.classification = 'DOCUMENT' AND l."documentKind" IS NULL`, website: `l."websiteStatus" <> 'READY'`, webp: 'TRUE' };
const active = `SELECT u.url, bool_or(w.visibility) AS visible FROM "Warehouse" w
  CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb,w.photos)) u(url) GROUP BY u.url`;

export class CronImageRepository extends ImageRepository {
  bounded(method, ...args) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
      return new CronImageRepository(tx)[method](...args);
    }, { maxWait: 3000, timeout: 13000 });
  }

  async pending(stage, limit) {
    if (!stages.has(stage) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid cron selection');
    return this.prisma.$queryRawUnsafe(`WITH active AS MATERIALIZED (${active})
      SELECT l.id FROM labeled_warehouse_images l JOIN active a ON a.url=l."imageUrl"
      WHERE ${missing[stage]} AND l."${stage}Attempts" < 5 AND (
        (l."${stage}Status" IN ('PENDING','FAILED') AND (l."${stage}NextAttemptAt" IS NULL OR l."${stage}NextAttemptAt"<=now()))
        OR (l."${stage}Status"='RUNNING' AND l."${stage}LeaseUntil"<now()))
      ORDER BY a.visible DESC NULLS LAST,l."${stage}Attempts",l.id LIMIT $1`, limit);
  }

  async expireClaims() {
    for (const stage of stages) await this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images
      SET "${stage}Status"='FAILED',"${stage}Error"='Worker lease expired after final attempt',
        "${stage}ClaimToken"=NULL,"${stage}LeaseUntil"=NULL,"${stage}NextAttemptAt"=NULL
      WHERE "${stage}Status"='RUNNING' AND "${stage}LeaseUntil"<now() AND "${stage}Attempts">=5`);
  }

  inventory() {
    return this.prisma.$queryRawUnsafe(`SELECT id,"webpObjectKey","webpCheckedAt"::text AS "webpCheckedAt"
      FROM labeled_warehouse_images WHERE "webpStatus"='READY'`);
  }

  markMissing(rows) {
    if (!rows.length) return 0;
    return this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images l
      SET "webpStatus"='PENDING',"webpAttempts"=0,"webpNextAttemptAt"=NULL,
        "webpError"='Previously stored WebP object is missing',"webpCheckedAt"=now()
      FROM jsonb_to_recordset($1::jsonb) AS r(id int,"webpObjectKey" text,"webpCheckedAt" timestamptz)
      WHERE l.id=r.id AND l."webpStatus"='READY' AND l."webpObjectKey" IS NOT DISTINCT FROM r."webpObjectKey"
        AND l."webpCheckedAt" IS NOT DISTINCT FROM r."webpCheckedAt"`, JSON.stringify(rows));
  }

  warehousePage(after) {
    return this.prisma.$queryRawUnsafe(`SELECT id,media,photos,"photosWebp" FROM "Warehouse"
      WHERE id>$1 ORDER BY id LIMIT 100`, after);
  }

  async projectPage(rows) {
    const images = await this.readImages(rows);
    let updated = 0;
    for (const row of rows) {
      const byUrl = new Map(images.get(row.id).map(image => [image.originalUrl, image.webpUrl]));
      let photos = row.photos;
      if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch {} }
      const slots = (Array.isArray(photos) ? photos : photos == null ? [] : [photos]).flatMap(value =>
        typeof value === 'string' ? value.split(/,\s*(?=https?:\/\/)/i).map(url => url.trim() || null) : [null]);
      const value = JSON.stringify(slots.map(url => byUrl.get(url) ?? null));
      if (value !== row.photosWebp) updated += await this.prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET "photosWebp"=$2
        WHERE id=$1 AND photos IS NOT DISTINCT FROM $3 AND "photosWebp" IS NOT DISTINCT FROM $4
          AND COALESCE(media::jsonb,'null'::jsonb) IS NOT DISTINCT FROM $5::jsonb`,
        row.id,value,row.photos,row.photosWebp,JSON.stringify(row.media));
    }
    return updated;
  }
}
