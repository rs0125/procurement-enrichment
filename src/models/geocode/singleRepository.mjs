export function geocodeRepository(prisma) {
  return {
    async get(id) {
      const [row]=await prisma.$queryRawUnsafe(`SELECT w.id,w."googleLocation",d.latitude,d.longitude
        FROM "Warehouse" w LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id WHERE w.id=$1`,id);
      return row;
    },
    async publish(row,result) {
      return prisma.$transaction(async tx=>{
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
        const current=await tx.$queryRawUnsafe(`SELECT id FROM "Warehouse" WHERE id=$1
          AND "googleLocation" IS NOT DISTINCT FROM $2 FOR UPDATE`,row.id,row.googleLocation);
        if(!current.length) return false;
        const saved=await tx.$executeRawUnsafe(`INSERT INTO "WarehouseData" ("warehouseId",latitude,longitude)
          VALUES ($1,$2,$3) ON CONFLICT ("warehouseId") DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude
          WHERE "WarehouseData".latitude IS NOT DISTINCT FROM $4 AND "WarehouseData".longitude IS NOT DISTINCT FROM $5`,
          row.id,result.lat,result.lng,row.latitude,row.longitude);
        if(saved) await tx.geocodeAttempt.upsert({where:{warehouseId:row.id},
          create:{warehouseId:row.id,attemptCount:1,lastVia:result.via,succeededAt:new Date()},
          update:{attemptCount:{increment:1},lastVia:result.via,lastError:null,succeededAt:new Date()}});
        return Boolean(saved);
      },{maxWait:3000,timeout:8000});
    }
  };
}
