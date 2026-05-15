export async function upsertCoords(tx, { warehouseId, lat, lng }) {
  return tx.warehouseData.upsert({
    where: { warehouseId },
    create: { warehouseId, latitude: lat, longitude: lng },
    update: { latitude: lat, longitude: lng },
  });
}
