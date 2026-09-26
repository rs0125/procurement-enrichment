// Shared verbatim with the website backend. Warehouse.media is never rewritten.
const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|svg)$/i;
function decodeJson(value) {
    for (let i = 0; i < 2 && typeof value === 'string'; i++) {
        try { value = JSON.parse(value); } catch { break; }
    }
    return value;
}
function urlSlots(value) {
    value = decodeJson(value);
    return (Array.isArray(value) ? value : [value]).flatMap(entry => typeof entry === 'string'
        ? entry.split(/,\s*(?=https?:\/\/)/i).map(url => url.trim()).filter(Boolean) : []);
}
function isImageUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\/[^/\s@?#]+\/.+/i.test(value)) return false;
    const path = value.split(/[?#]/)[0];
    return IMAGE_PATH.test(path) || !/\.[^/.]+$/.test(path);
}
function imageUrls(warehouse) {
    const media = decodeJson(warehouse?.media);
    // Empty arrays are intentional removals; photos is only a legacy fallback.
    const input = Array.isArray(media?.images) ? media.images : warehouse?.photos;
    return [...new Set(urlSlots(input).filter(isImageUrl))];
}
function serializeImage(originalUrl, row) {
    const webpUrl = row?.webpUrl && isImageUrl(row.webpUrl)
        ? row.webpUrl : null;
    const jpegUrl = row?.jpegUrl && isImageUrl(row.jpegUrl)
        ? row.jpegUrl : null;
    return {
        id: row?.id ?? null, originalUrl, webpUrl, jpegUrl,
        displayUrl: webpUrl || originalUrl,
        classification: row?.classification ?? null,
        documentKind: row?.documentKind ?? null,
        caption: row?.description ?? null,
    };
}
function imagesForWarehouse(warehouse, rows) {
    const byUrl = rows instanceof Map ? rows : new Map(rows.map(row => [row.imageUrl, row]));
    return imageUrls(warehouse).map(url => serializeImage(url, byUrl.get(url)));
}
module.exports = { decodeJson, urlSlots, isImageUrl, imageUrls, serializeImage, imagesForWarehouse };
