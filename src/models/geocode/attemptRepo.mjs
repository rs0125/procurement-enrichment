export function geocodeCandidates(prisma) {
  return {
    async pending(limit = 101) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new Error('Invalid geocoder batch size');
      return prisma.$queryRaw`
        SELECT w.id FROM "Warehouse" w
        LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id
        LEFT JOIN "GeocodeAttempt" a ON a."warehouseId"=w.id
        WHERE w."googleLocation" IS NOT NULL AND w."googleLocation"<>''
          AND (w."createdAt">now()-interval '7 days' OR w."status_updated_at">now()-interval '7 days')
          AND (d.latitude IS NULL OR d.longitude IS NULL) AND a."succeededAt" IS NULL
          AND (a.id IS NULL OR (a."attemptCount"<5 AND a."lastAttemptAt"<now()-interval '24 hours'))
        ORDER BY greatest(w."createdAt",coalesce(w."status_updated_at",w."createdAt")) DESC,w.id
        LIMIT ${limit}`;
    }
  };
}
