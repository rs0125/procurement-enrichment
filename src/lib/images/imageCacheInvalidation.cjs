const { createHmac } = require('node:crypto');

// One request per committed batch/run, never per image. A missing/unavailable
// endpoint leaves the website's bounded cache TTL as the fallback.
async function invalidateImageCache() {
    const target = process.env.IMAGE_PIPELINE_CACHE_URL;
    const key = process.env.R2_SECRET_ACCESS_KEY?.trim();
    if (!target || !key) return;
    try {
        const url = new URL(target);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid cache URL');
        const token = createHmac('sha256', key).update('wareongo:image-cache-invalidate:v1').digest('hex');
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('Cache invalidation failed');
    } catch { console.warn('Image cache invalidation deferred to website cache TTL'); }
}
module.exports = { invalidateImageCache };
