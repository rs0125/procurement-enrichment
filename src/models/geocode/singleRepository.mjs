export function geocodeRepository(prisma,{inTransaction=false,attemptReserved=false}={}) {
  const transaction=(work,options)=>inTransaction?work(prisma):prisma.$transaction(work,options);
  return {
    async get(id) {
      const [row]=await prisma.$queryRawUnsafe(`SELECT w.id,w."googleLocation",d.latitude,d.longitude
        FROM "Warehouse" w LEFT JOIN "WarehouseData" d ON d."warehouseId"=w.id WHERE w.id=$1`,id);
      return row;
    },
    async fail(row,result) {
      return transaction(async tx=>{
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
        const current=await tx.$queryRawUnsafe(`SELECT id FROM "Warehouse" WHERE id=$1
          AND "googleLocation" IS NOT DISTINCT FROM $2 FOR UPDATE`,row.id,row.googleLocation);
        if(!current.length) return false;
        const [coords]=await tx.$queryRawUnsafe(`SELECT latitude,longitude FROM "WarehouseData" WHERE "warehouseId"=$1 FOR UPDATE`,row.id);
        if((coords?.latitude ?? null)!==(row.latitude ?? null) || (coords?.longitude ?? null)!==(row.longitude ?? null)) return false;
        const via=['url_@','url_!3d!4d','url_/search/','url_ll=','url_q=','url_dms','cid_lookup','no_match','error_resolve','error_cid','error_thrown'].includes(result.via)?result.via:'no_match';
        await tx.geocodeAttempt.upsert({where:{warehouseId:row.id},
          create:{warehouseId:row.id,attemptCount:1,lastVia:via,lastError:'coordinates_not_found'},
          update:{attemptCount:{increment:attemptReserved?0:1},lastVia:via,lastError:'coordinates_not_found'}});
        return true;
      },{maxWait:3000,timeout:8000});
    },
    async publish(row,result) {
      if(!Number.isFinite(result.lat) || !Number.isFinite(result.lng) || Math.abs(result.lat)>90 || Math.abs(result.lng)>180) return false;
      return transaction(async tx=>{
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
          update:{attemptCount:{increment:attemptReserved?0:1},lastVia:result.via,lastError:null,succeededAt:new Date()}});
        return Boolean(saved);
      },{maxWait:3000,timeout:8000});
    }
  };
}
