const { randomUUID } = require('node:crypto');
const { imageUrls, imagesForWarehouse } = require('../../lib/images/imageContract.cjs');

const STAGES = new Set(['label', 'document', 'webp', 'website']);
const MAX_ATTEMPTS = 5;
const refs = `SELECT w.id AS "warehouseId", w.visibility, u.url
  FROM "Warehouse" w CROSS JOIN LATERAL unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) u(url)`;
const columns = `l.id, l."imageUrl", l.classification, l.description, l.confidence,
  l."documentKind", l."webpUrl", l."jpegUrl"`;
const missing = { label: 'l.classification IS NULL', document: `l.classification = 'DOCUMENT' AND l."documentKind" IS NULL`, webp: 'TRUE', website: `l."websiteStatus" <> 'READY'` };
function stageName(stage) {
    if (!STAGES.has(stage)) throw new Error('Invalid image processing stage');
    return stage;
}

// No network/model calls inside transactions. Every publication is guarded by
// the current per-image lease; workers own disjoint groups of result columns.
class ImagePipelineRepository {
    constructor(prisma) { this.prisma = prisma; }

    async register(warehouseId = null) {
        return this.prisma.$executeRawUnsafe(`
          INSERT INTO labeled_warehouse_images ("warehouseId", "imageUrl", "labelStatus", "webpStatus")
          SELECT min("warehouseId"), url, 'PENDING', 'PENDING' FROM (${refs}
            WHERE ($1::integer IS NULL OR w.id = $1)) r GROUP BY url
          ON CONFLICT ("imageUrl") DO UPDATE SET "unreferencedAt" = NULL
          WHERE labeled_warehouse_images."unreferencedAt" IS NOT NULL`, warehouseId);
    }

    async reconcile() {
        const registered = await this.register();
        // Retention only. Never delete labels, originals or compressed metadata.
        const retained = await this.prisma.$executeRawUnsafe(`
          UPDATE labeled_warehouse_images l SET "unreferencedAt" = now()
          WHERE "unreferencedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM (${refs}) r WHERE r.url = l."imageUrl")`);
        return { registered, retained };
    }

    async claim(stage, { limit = 50, warehouseId = null, allEntries = false, imageId = null } = {}) {
        stageName(stage);
        if (allEntries && stage !== 'website') throw new Error('All-entry claims are only supported for website backfills');
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid image batch size');
        // An interrupted final attempt becomes visible as an exhausted failure.
        await this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET "${stage}Status" = 'FAILED',
          "${stage}Error" = 'Worker lease expired after final attempt', "${stage}ClaimToken" = NULL,
          "${stage}LeaseUntil" = NULL, "${stage}NextAttemptAt" = NULL
          WHERE "${stage}Status" = 'RUNNING' AND "${stage}LeaseUntil" < now() AND "${stage}Attempts" >= $1 AND ($2::int IS NULL OR id = $2)`, MAX_ATTEMPTS, imageId);
        const token = randomUUID();
        const active = imageId !== null
            ? `SELECT l."imageUrl" AS url, bool_or(w.visibility) AS visible
               FROM labeled_warehouse_images l JOIN "Warehouse" w
                 ON l."imageUrl" = ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))
               WHERE l.id = $5 AND ($3::int IS NULL OR w.id = $3) GROUP BY l."imageUrl"`
            : allEntries
            ? `SELECT "imageUrl" AS url, false AS visible FROM labeled_warehouse_images WHERE ($3::integer IS NULL OR "warehouseId" = $3)`
            : `SELECT url, bool_or(visibility) AS visible FROM (${refs}
              WHERE ($3::integer IS NULL OR w.id = $3)) r GROUP BY url`;
        return this.prisma.$queryRawUnsafe(`WITH active AS MATERIALIZED (
            ${active}
          ), picked AS (
            SELECT l.id FROM labeled_warehouse_images l JOIN active a ON a.url = l."imageUrl"
            WHERE ($5::int IS NULL OR l.id = $5) AND ${missing[stage]} AND l."${stage}Attempts" < $4 AND (
              (l."${stage}Status" IN ('PENDING','FAILED') AND
                (l."${stage}NextAttemptAt" IS NULL OR l."${stage}NextAttemptAt" <= now())) OR
              (l."${stage}Status" = 'RUNNING' AND l."${stage}LeaseUntil" < now())
            ) ORDER BY a.visible DESC NULLS LAST, l."${stage}Attempts", l.id
            LIMIT $1 FOR UPDATE OF l SKIP LOCKED
          ) UPDATE labeled_warehouse_images l SET "${stage}Status" = 'RUNNING',
            "${stage}ClaimToken" = $2, "${stage}LeaseUntil" = now() + interval '5 minutes',
            "${stage}Attempts" = l."${stage}Attempts" + 1
          FROM picked WHERE l.id = picked.id RETURNING l.id, l."warehouseId", l."imageUrl",
            l."${stage}ClaimToken", l."${stage}Attempts", l."webpObjectKey", l."webpVersion"`, limit, token, warehouseId, MAX_ATTEMPTS, imageId);
    }

    async complete(stage, row, result) {
        stageName(stage);
        const token = row[`${stage}ClaimToken`];
        let assignments;
        if (stage === 'label') assignments = `classification = ($3::jsonb->>'classification')::"ImageClass",
          description = $3::jsonb->>'description', model = $3::jsonb->>'model',
          confidence = ($3::jsonb->>'confidence')::double precision, "labelledAt" = now(),
          "documentKind" = ($3::jsonb->>'documentKind')::"DocumentKind",
          "documentStatus" = CASE WHEN $3::jsonb->>'classification' = 'DOCUMENT' AND $3::jsonb->>'documentKind' IS NULL
            THEN 'PENDING' ELSE 'READY' END`;
        else if (stage === 'document') assignments = `"documentKind" = ($3::jsonb->>'documentKind')::"DocumentKind"`;
        else if (stage === 'website') assignments = `"websiteDecision" = $3::jsonb->>'decision',
          "websiteQualityTier" = $3::jsonb->>'qualityTier', "websiteAssessment" = $3::jsonb->'assessment',
          "websiteAssessedAt" = now()`;
        else assignments = `"storageBucket" = $3::jsonb->>'storageBucket',
          "originalObjectKey" = $3::jsonb->>'originalObjectKey', "webpUrl" = $3::jsonb->>'webpUrl',
          "webpObjectKey" = $3::jsonb->>'webpObjectKey', "webpBytes" = ($3::jsonb->>'webpBytes')::bigint,
          "webpAt" = ($3::jsonb->>'webpAt')::timestamptz, "webpCheckedAt" = now(),
          "webpVersion" = $3::jsonb->>'webpVersion'`;
        return this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET ${assignments},
          "${stage}Status" = 'READY', "${stage}Error" = NULL, "${stage}NextAttemptAt" = NULL,
          "${stage}ClaimToken" = NULL, "${stage}LeaseUntil" = NULL
          WHERE id = $1 AND "${stage}ClaimToken" = $2 AND "${stage}LeaseUntil" > now() AND "imageUrl" = $4`,
        row.id, token, JSON.stringify(result), row.imageUrl);
    }

    async fail(stage, row, reason, { unsupported = false, deferred = false } = {}) {
        stageName(stage);
        const attempts = row[`${stage}Attempts`];
        const next = deferred ? null : attempts >= MAX_ATTEMPTS || unsupported ? null
            : new Date(Date.now() + Math.min(24 * 60, 5 * 2 ** (attempts - 1)) * 60_000);
        return this.prisma.$executeRawUnsafe(`UPDATE labeled_warehouse_images SET
          "${stage}Status" = $3, "${stage}Error" = $4, "${stage}NextAttemptAt" = $5::timestamptz,
          "${stage}Attempts" = GREATEST(0, "${stage}Attempts" - $6),
          "${stage}ClaimToken" = NULL, "${stage}LeaseUntil" = NULL
          WHERE id = $1 AND "${stage}ClaimToken" = $2 AND "${stage}LeaseUntil" > now() AND "imageUrl" = $7`,
        row.id, row[`${stage}ClaimToken`], deferred ? 'PENDING' : unsupported ? 'UNSUPPORTED' : 'FAILED',
        deferred ? null : String(reason).slice(0, 500), next, deferred ? 1 : 0, row.imageUrl);
    }

    async backlog(stage, { allEntries = false } = {}) {
        stageName(stage);
        if (allEntries && stage !== 'website') throw new Error('All-entry backlog is only supported for website backfills');
        const rows = await this.prisma.$queryRawUnsafe(`SELECT l."${stage}Status" AS status, count(*)::int AS count
          FROM labeled_warehouse_images l WHERE ${missing[stage]}
          ${allEntries ? '' : `AND EXISTS (SELECT 1 FROM (${refs}) r WHERE r.url = l."imageUrl")`} GROUP BY l."${stage}Status"`);
        return Object.fromEntries(rows.map(row => [row.status, row.count]));
    }

    async rowsForWarehouses(ids) {
        if (!ids.length) return [];
        return this.prisma.$queryRawUnsafe(`SELECT w.id AS "warehouseId", u.url AS "originalUrl", ${columns}
          FROM "Warehouse" w CROSS JOIN LATERAL
            unnest(public.wareongo_image_urls(w.media::jsonb, w.photos)) WITH ORDINALITY u(url, ord)
          LEFT JOIN labeled_warehouse_images l ON l."imageUrl" = u.url
          WHERE w.id IN (SELECT value::int FROM jsonb_array_elements_text($1::jsonb)) ORDER BY w.id, u.ord`, JSON.stringify(ids));
    }

    async readImages(warehouses) {
        const urls = [...new Set(warehouses.flatMap(imageUrls))];
        const rows = urls.length ? await this.prisma.$queryRawUnsafe(`SELECT ${columns} FROM labeled_warehouse_images l
          WHERE l."imageUrl" IN (SELECT jsonb_array_elements_text($1::jsonb))`, JSON.stringify(urls)) : [];
        const byUrl = new Map(rows.map(row => [row.imageUrl, row]));
        return new Map(warehouses.map(w => [w.id, imagesForWarehouse(w, byUrl)]));
    }
}

// The warehouse write has already committed. Registration failures are repaired
// by reconciliation; they must not tell a submitter their accepted write failed.
async function registerWarehouseImages(prisma, warehouseId) {
    try { await new ImagePipelineRepository(prisma).register(warehouseId); }
    catch { console.error('Image registration deferred to reconciliation', { warehouseId }); }
}

module.exports = { ImagePipelineRepository, registerWarehouseImages, MAX_ATTEMPTS };
