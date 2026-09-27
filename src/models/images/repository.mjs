import pipeline from './pipeline.cjs';

export class ImageRepository extends pipeline.ImagePipelineRepository {
  async getActive(id) {
    const [row] = await this.prisma.$queryRawUnsafe(`SELECT l.*, l."jpegAt"::text AS "jpegAtExact",
      ARRAY(SELECT w.id FROM "Warehouse" w
        WHERE l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))) AS "warehouseIds"
      FROM labeled_warehouse_images l WHERE l.id=$1`, id);
    return row?.warehouseIds?.length ? row : null;
  }

  async projectLegacy(imageId) {
    const rows = await this.prisma.$queryRawUnsafe(`SELECT w.id, w.photos, w."photosWebp", w.media
      FROM "Warehouse" w JOIN labeled_warehouse_images l ON l.id=$1
      WHERE l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))`, imageId);
    for (const row of rows) {
      const images = await this.readImages([row]);
      const byUrl = new Map(images.get(row.id).map(image => [image.originalUrl, image.webpUrl]));
      let photos = row.photos;
      if (typeof photos === 'string') { try { photos = JSON.parse(photos); } catch {} }
      const slots = (Array.isArray(photos) ? photos : photos == null ? [] : [photos]).flatMap(value =>
        typeof value === 'string' ? value.split(/,\s*(?=https?:\/\/)/i).map(url => url.trim() || null) : [null]);
      const value = JSON.stringify(slots.map(url => byUrl.get(url) ?? null));
      if (value !== row.photosWebp) await this.prisma.$executeRawUnsafe(`UPDATE "Warehouse" SET "photosWebp"=$2
        WHERE id=$1 AND photos IS NOT DISTINCT FROM $3 AND "photosWebp" IS NOT DISTINCT FROM $4
        AND COALESCE(media::jsonb,'null'::jsonb) IS NOT DISTINCT FROM $5::jsonb`,
        row.id, value, row.photos, row.photosWebp, JSON.stringify(row.media));
    }
  }
}
