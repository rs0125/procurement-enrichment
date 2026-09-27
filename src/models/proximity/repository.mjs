import { Prisma } from "../../generated/prisma/client.ts";
import { COORDINATE_EPSILON } from '../../lib/proximity/coordinates.mjs';
class BaseModel { constructor(prisma) { this.prisma = prisma; } handleDatabaseError(error) { throw error; } }
const { TARGET_HIGHWAY, categoryFor } = await import('../../lib/proximity/osmCategories.cjs').then(m => m.default);

/**
 * WarehouseProximityModel — the spatial reads and writes behind the proximity
 * backfill.
 *
 * The KNN queries here are the first ST_DWithin / `<->` in this repo. Every spatial
 * read before them was a bounding-box `&&` test (see GeoModel), so the GiST indexes
 * on the generated geography columns have never actually been asked a
 * nearest-neighbour question. They are index-backed from the first call.
 *
 * Raw SQL because Prisma has no geometry types, the same arrangement GeoModel and
 * the `WarehouseData.embedding` vector column already use.
 */
class WarehouseProximityModel extends BaseModel {
    constructor(prismaClient = null) {
        super(prismaClient);
        this.model = this.prisma.warehouseProximity;
    }

    /**
     * Which POI categories are safe to compute against.
     *
     * The ingest records one row per (region, category) in osm_ingest_tile,
     * INCLUDING regions that came back empty, so partial coverage is detectable
     * rather than silent. A category fetched for only part of the country would
     * otherwise produce a confident "nearest hospital is 180 km away" for every
     * warehouse in a region that was never fetched — an artefact of our own ingest
     * presented as a fact about the site. Refusing to compute is the only honest
     * option.
     *
     * @param {Object<string, number>} expectedRegions - category -> regions required
     * @returns {Promise<Array<{category: string, done: number, expected: number, complete: boolean}>>}
     */
    async coverage(expectedRegions) {
        try {
            const rows = await this.prisma.osmIngestTile.groupBy({
                by: ['category', 'status'],
                _count: { _all: true },
            });
            const done = new Map();
            for (const r of rows) {
                // 'empty' counts as fetched: the region was covered and genuinely
                // held nothing. 'failed' and 'pending' do not.
                if (r.status !== 'ok' && r.status !== 'empty') continue;
                done.set(r.category, (done.get(r.category) || 0) + r._count._all);
            }
            return Object.entries(expectedRegions).map(([category, expected]) => {
                const got = done.get(category) || 0;
                return { category, done: got, expected, complete: got >= expected };
            });
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** MAX(importedAt) per POI category, stamped on rows so a re-import is visible. */
    async poiWatermarks() {
        try {
            const poi = await this.prisma.$queryRaw`
                SELECT category, MAX("importedAt") AS watermark FROM osm_poi GROUP BY category`;
            const hw = await this.prisma.$queryRaw`
                SELECT MAX("importedAt") AS watermark FROM osm_highway`;
            const out = new Map(poi.map((r) => [r.category, r.watermark]));
            if (hw[0] && hw[0].watermark) out.set('national_highway', hw[0].watermark);
            return out;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Warehouses with usable coordinates, newest first so fresh listings never starve. */
    async warehousesToCompute({ ids = null, limit = null } = {}) {
        try {
            const idFilter = ids && ids.length
                ? Prisma.sql`AND d."warehouseId" IN (${Prisma.join(ids)})`
                : Prisma.empty;
            const take = limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty;
            return await this.prisma.$queryRaw`
                SELECT d."warehouseId" AS id, d.latitude AS lat, d.longitude AS lng
                FROM "WarehouseData" d
                WHERE d.geog IS NOT NULL ${idFilter}
                ORDER BY d."warehouseId" DESC
                ${take}`;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Missing/stale categories, with durable retry cooldowns in the existing run log. */
    async findPending(categories, limit = 5) {
        if (!categories.length) return [];
        const specs = Prisma.join(categories.map(c => Prisma.sql`(${c.key})`));
        return this.prisma.$queryRaw`
            WITH categories(category) AS (VALUES ${specs})
            SELECT d."warehouseId" AS id, d.latitude AS lat, d.longitude AS lng
            FROM "WarehouseData" d
            WHERE d.geog IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM categories c WHERE NOT EXISTS (
                    SELECT 1 FROM warehouse_proximity p
                    WHERE p."warehouseId" = d."warehouseId" AND p.category = c.category
                      AND abs(p."computedFromLat" - d.latitude) <= ${COORDINATE_EPSILON}
                      AND abs(p."computedFromLng" - d.longitude) <= ${COORDINATE_EPSILON}
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM "CronRunLog" r
                WHERE r."jobName" = 'warehouse_proximity:' || d."warehouseId"::text
                  AND r.status = 'FAILED' AND r."ranAt" > now() - interval '1 day'
                  AND abs((r.metadata->>'lat')::double precision - d.latitude) <= ${COORDINATE_EPSILON}
                  AND abs((r.metadata->>'lng')::double precision - d.longitude) <= ${COORDINATE_EPSILON}
                  AND (r.metadata->>'retryAt')::timestamptz > now()
              )
            ORDER BY d."warehouseId" DESC LIMIT ${limit}`;
    }

    async rowsFor(warehouseId) {
        return this.model.findMany({ where: { warehouseId } });
    }

    /** Each spatial statement has its own short transaction; none spans routing. */
    async bounded(method, ...args) {
        return this.prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
            return new WarehouseProximityModel(tx)[method](...args);
        }, { maxWait: 3000, timeout: 8000 });
    }

    /** Don't publish results if a coordinate edit arrived while we were routing. */
    async upsertCurrent(warehouse, rows) {
        return this.prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
            const current = await tx.$queryRaw`
                SELECT "warehouseId" FROM "WarehouseData"
                WHERE "warehouseId" = ${warehouse.id}
                  AND abs(latitude - ${warehouse.lat}) <= ${COORDINATE_EPSILON}
                  AND abs(longitude - ${warehouse.lng}) <= ${COORDINATE_EPSILON}
                FOR UPDATE`;
            if (!current.length) return 0;
            return new WarehouseProximityModel(tx).upsertMany(warehouse.id, rows, { onlyMissingOrStale: true });
        }, { maxWait: 3000, timeout: 8000 });
    }

    /**
     * The k nearest POIs to one point, per category, in one query.
     *
     * `ORDER BY geog <-> point LIMIT k` is the KNN operator: GiST returns rows
     * already in distance order, so no category is ever sorted. On `geography` it is
     * exact, not an approximation.
     *
     * ST_DWithin is simultaneously the per-category radius cap and the correctness
     * bound this codebase's house style demands — without it, `<-> LIMIT k` happily
     * returns the nearest airport 900 km away and calls it a selling point. The same
     * argument GeoModel makes for its bounding boxes: the bound is a correctness
     * property, not an optimisation.
     *
     * @param {{lat: number, lng: number}} at
     * @param {Array<{key: string, maxRadiusKm: number, candidates: number}>} categories
     * @returns {Promise<Array<object>>} rows with category, poiSource, poiId, name, lat, lng, directM
     */
    async nearestPois(at, categories) {
        if (!categories.length) return [];
        try {
            const specs = Prisma.join(categories.map((c) => Prisma.sql`
                (${c.key}, ${c.maxRadiusKm * 1000}::double precision, ${c.candidates}::int)`));
            // The whole-table `false` argument to ST_DWithin/ST_Distance selects the
            // sphere over the spheroid: several times faster, and far more accurate
            // than a shortlist needs.
            return await this.prisma.$queryRaw`
                WITH origin AS (
                    SELECT ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326)::geography AS g
                ), spec(category, radius_m, k) AS (VALUES ${specs})
                SELECT s.category,
                       'osm_poi'  AS "poiSource",
                       p.id::text AS "poiId",
                       p.name,
                       p.lat,
                       p.lng,
                       p."directM"
                FROM spec s
                CROSS JOIN origin o
                CROSS JOIN LATERAL (
                    SELECT x.id, x.name, x.lat, x.lng,
                           ST_Distance(x.geog, o.g, false) AS "directM"
                    FROM osm_poi x
                    WHERE x.category = s.category
                      AND ST_DWithin(x.geog, o.g, s.radius_m, false)
                    ORDER BY x.geog <-> o.g
                    LIMIT s.k
                ) p
                ORDER BY s.category, p."directM"`;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * The nearest numbered highway line to one point.
     *
     * Separate from nearestPois because a highway is a LINE, not a point, so the
     * distance is to the nearest position along it — and because osm_highway is a
     * different table with a different key type.
     *
     * Returns the road's identity only. No distance is reported downstream: 95.5% of
     * India's numbered-highway mileage is not access-controlled, so a
     * distance-to-carriageway figure describes a road you often cannot join there,
     * and a distance-to-ramp figure exists only for the other 4.5%.
     */
    async nearestHighway(at, maxRadiusKm) {
        try {
            const rows = await this.prisma.$queryRaw`
                WITH origin AS (
                    SELECT ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326)::geography AS g
                )
                SELECT h.id::text AS "poiId",
                       COALESCE(h.ref, h.name) AS name,
                       h.highway,
                       h.refs,
                       ST_Distance(h.geog, o.g, false) AS "directM"
                FROM osm_highway h
                CROSS JOIN origin o
                WHERE h.geog IS NOT NULL
                  AND ST_DWithin(h.geog, o.g, ${maxRadiusKm * 1000}::double precision, false)
                ORDER BY h.geog <-> o.g
                LIMIT 1`;
            return rows.map((r) => ({ ...r, poiSource: 'osm_highway', lat: null, lng: null }));
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /**
     * Write one warehouse's rows.
     *
     * ON CONFLICT DO UPDATE, and NOT createMany({ skipDuplicates: true }). The
     * skipDuplicates form is this repo's house pattern and it is actively wrong
     * here: with the unique key in place it silently ignores rows that already
     * exist, which makes every recompute a no-op. The feature would appear to work
     * and never update anything.
     *
     * `attempts` accumulates in SQL rather than in JS so a bounded retry stays
     * correct if two processes ever run at once.
     */
    async upsertMany(warehouseId, rows, { onlyMissingOrStale = false } = {}) {
        if (!rows.length) return 0;
        const perRow = 17;
        const tuples = rows.map((_, i) => {
            const b = i * perRow;
            return `($${b + 1}::int, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text,`
                + ` $${b + 5}::text, $${b + 6}::text, $${b + 7}::double precision,`
                + ` $${b + 8}::double precision, $${b + 9}::double precision, $${b + 10}::int,`
                + ` $${b + 11}::text, $${b + 12}::text, $${b + 13}::int, $${b + 14}::text[],`
                + ` $${b + 15}::double precision, $${b + 16}::double precision, $${b + 17}::timestamptz)`;
        }).join(', ');
        const params = rows.flatMap((r) => [
            warehouseId, r.category, r.status, r.landmarkName,
            r.poiSource, r.poiId, r.poiLat,
            r.poiLng, r.roadKm, r.driveMinutes,
            r.provider, r.profile, r.candidates, r.warnings || [],
            r.computedFromLat, r.computedFromLng, r.poiWatermark,
        ]);
        const sql = `
            INSERT INTO warehouse_proximity
                ("warehouseId", category, status, "landmarkName", "poiSource", "poiId", "poiLat",
                 "poiLng", "roadKm", "driveMinutes", provider, profile, candidates, warnings,
                 "computedFromLat", "computedFromLng", "poiWatermark", "computedAt")
            SELECT v.*, now() FROM (VALUES ${tuples}) AS v
            ON CONFLICT ("warehouseId", category) DO UPDATE SET
                status = EXCLUDED.status,
                "landmarkName" = EXCLUDED."landmarkName",
                "poiSource" = EXCLUDED."poiSource",
                "poiId" = EXCLUDED."poiId",
                "poiLat" = EXCLUDED."poiLat",
                "poiLng" = EXCLUDED."poiLng",
                "roadKm" = EXCLUDED."roadKm",
                "driveMinutes" = EXCLUDED."driveMinutes",
                provider = EXCLUDED.provider,
                profile = EXCLUDED.profile,
                candidates = EXCLUDED.candidates,
                warnings = EXCLUDED.warnings,
                "computedFromLat" = EXCLUDED."computedFromLat",
                "computedFromLng" = EXCLUDED."computedFromLng",
                "poiWatermark" = EXCLUDED."poiWatermark",
                "computedAt" = now(),
                attempts = CASE WHEN EXCLUDED.status = 'ROUTING_FAILED'
                                  AND warehouse_proximity."computedFromLat" IS NOT DISTINCT FROM EXCLUDED."computedFromLat"
                                  AND warehouse_proximity."computedFromLng" IS NOT DISTINCT FROM EXCLUDED."computedFromLng"
                                THEN warehouse_proximity.attempts + 1 ELSE 1 END
                ${onlyMissingOrStale ? `WHERE warehouse_proximity."computedFromLat" IS NULL OR warehouse_proximity."computedFromLng" IS NULL
                    OR abs(warehouse_proximity."computedFromLat" - EXCLUDED."computedFromLat") > ${COORDINATE_EPSILON}
                    OR abs(warehouse_proximity."computedFromLng" - EXCLUDED."computedFromLng") > ${COORDINATE_EPSILON}` : ''}`;
        try {
            return await this.prisma.$executeRawUnsafe(sql, ...params);
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Warehouse ids already computed for every given category, so a re-run skips them. */
    async alreadyComputed(categories) {
        try {
            const rows = await this.prisma.$queryRaw`
                SELECT "warehouseId", count(*)::int AS n
                FROM warehouse_proximity
                WHERE category IN (${Prisma.join(categories)})
                GROUP BY "warehouseId"
                HAVING count(*) >= ${categories.length}`;
            return new Set(rows.map((r) => r.warehouseId));
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }

    /** Census for the verification pass. */
    async census() {
        try {
            return await this.prisma.$queryRaw`
                SELECT category, status, count(*)::int AS n,
                       round(avg("roadKm")::numeric, 1) AS avg_km
                FROM warehouse_proximity
                GROUP BY category, status ORDER BY category, status`;
        } catch (error) {
            this.handleDatabaseError(error);
        }
    }
}

/** Regions each ingest category needs before it can be trusted as complete. */
WarehouseProximityModel.expectedRegionsFor = (keys, footprintTiles, gridCells) => {
    const out = {};
    for (const key of keys) {
        const ingest = categoryFor(key);
        if (!ingest) continue;
        if (ingest.scope === 'footprint') out[key] = footprintTiles;
        else if (ingest.scope === 'grid') out[key] = gridCells[key] || 1;
        else out[key] = 1;
    }
    return out;
};

WarehouseProximityModel.TARGET_HIGHWAY = TARGET_HIGHWAY;

export default WarehouseProximityModel;
