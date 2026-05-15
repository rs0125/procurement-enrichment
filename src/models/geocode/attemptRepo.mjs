import { prisma } from "../../config/prisma.mjs";

export async function findPendingRecent() {
  return prisma.$queryRaw`
    select w.id, w."googleLocation"
    from "Warehouse" w
    left join "WarehouseData"   d on d."warehouseId" = w.id
    left join "GeocodeAttempt"  a on a."warehouseId" = w.id
    where w."googleLocation" is not null
      and w."googleLocation" <> ''
      and w."createdAt" > now() - interval '7 days'
      and (d.latitude is null or d.longitude is null)
      and a."succeededAt" is null
      and (
        a.id is null
        or (a."attemptCount" < 5
            and a."lastAttemptAt" < now() - interval '24 hours')
      )
    order by w."createdAt" desc
  `;
}

export async function recordSuccess(tx, { warehouseId, via }) {
  return tx.geocodeAttempt.upsert({
    where: { warehouseId },
    create: {
      warehouseId,
      attemptCount: 1,
      lastVia: via,
      succeededAt: new Date(),
    },
    update: {
      attemptCount: { increment: 1 },
      lastVia: via,
      lastError: null,
      succeededAt: new Date(),
    },
  });
}

export async function recordFailure(tx, { warehouseId, via, error }) {
  return tx.geocodeAttempt.upsert({
    where: { warehouseId },
    create: {
      warehouseId,
      attemptCount: 1,
      lastVia: via,
      lastError: error ?? null,
    },
    update: {
      attemptCount: { increment: 1 },
      lastVia: via,
      lastError: error ?? null,
    },
  });
}
