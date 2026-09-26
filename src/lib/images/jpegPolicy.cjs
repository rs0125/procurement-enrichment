const { createHash } = require('node:crypto');
const JPEG_FIELDS = ['jpegUrl','jpegBytes','jpegAt','jpegVersion','jpegStatus','jpegError'];
const SMALL_BYTES = 200 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const PHOTO_VERSION = 'jpeg-1280-q82-progressive-420-v1';
const DOCUMENT_VERSION = 'jpeg-1920-q82-progressive-420-v1';
const REUSE_VERSION = 'jpeg-original-reuse-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const maxEdge = row => row.classification === 'DOCUMENT' ? 1920 : 1280;
const versionFor = row => maxEdge(row) === 1920 ? DOCUMENT_VERSION : PHOTO_VERSION;
const jpegPath = url => /\.jpe?g([?#].*)?$/i.test(url);

function reusable(metadata, bytes, edge, url, { smallOnly = true } = {}) {
    return metadata.format === 'jpeg' && jpegPath(url) && bytes > 0
        && (!smallOnly || bytes <= SMALL_BYTES)
        && metadata.width > 0 && metadata.height > 0
        && metadata.width <= edge && metadata.height <= edge
        && (!metadata.orientation || metadata.orientation === 1)
        && (!metadata.space || ['srgb', 'b-w'].includes(metadata.space))
        && (!metadata.pages || metadata.pages === 1);
}

function complete(row) {
    return row.jpegStatus === 'READY' && row.jpegUrl && (
        row.jpegVersion === versionFor(row)
        || (row.jpegVersion === REUSE_VERSION && row.jpegUrl === row.imageUrl));
}

function targetFor(row, sourceHash, publicBase) {
    const key = `jpeg/images/${sha(row.imageUrl)}/${versionFor(row)}/${sourceHash}.jpg`;
    return { key, url: `${new URL(publicBase).origin}/${key}` };
}

async function publish(prisma, row, result) {
    const rows = await prisma.$queryRawUnsafe(`WITH current AS MATERIALIZED (
      SELECT l.id,md5((to_jsonb(l)-$9::text[])::text) AS digest FROM labeled_warehouse_images l
      WHERE l.id=$1 AND l."imageUrl"=$2
        AND l."jpegUrl" IS NOT DISTINCT FROM $3 AND l."jpegVersion" IS NOT DISTINCT FROM $4
        AND l."jpegStatus"=$5 AND l."jpegAt" IS NOT DISTINCT FROM $6::timestamptz
        AND l.classification::text IS NOT DISTINCT FROM $12
        AND EXISTS (SELECT 1 FROM "Warehouse" w WHERE w.id=ANY($7::int[])
          AND l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))) FOR UPDATE OF l
    ) UPDATE labeled_warehouse_images l SET "jpegUrl"=$8,"jpegBytes"=$10::bigint,
      "jpegAt"=now(),"jpegVersion"=$11,"jpegStatus"='READY',"jpegError"=NULL FROM current c
      WHERE l.id=c.id RETURNING l.id,
      1 / CASE WHEN md5((to_jsonb(l)-$9::text[])::text)=c.digest THEN 1 ELSE 0 END AS preserved`,
    row.id, row.imageUrl, row.jpegUrl, row.jpegVersion, row.jpegStatus, row.jpegAt,
    row.warehouseIds, result.url, JPEG_FIELDS, result.bytes, result.version, row.classification);
    return rows.length === 1;
}


module.exports={SMALL_BYTES,PHOTO_VERSION,DOCUMENT_VERSION,REUSE_VERSION,maxEdge,versionFor,reusable,complete,targetFor,publish};
