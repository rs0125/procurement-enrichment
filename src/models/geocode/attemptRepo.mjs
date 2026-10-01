import { GEOCODE_ELIGIBILITY_SQL } from './eligibility.mjs';

export function geocodeCandidates(prisma) {
  return {
    async pending(limit = 101) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new Error('Invalid geocoder batch size');
      return prisma.$queryRawUnsafe(`
        SELECT w.id FROM "Warehouse" w
        LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id
        LEFT JOIN "GeocodeAttempt" a ON a."warehouseId"=w.id
        WHERE ${GEOCODE_ELIGIBILITY_SQL}
        ORDER BY greatest(w."createdAt",coalesce(w."status_updated_at",w."createdAt")) DESC,w.id
        LIMIT $1`, limit);
    }
  };
}
