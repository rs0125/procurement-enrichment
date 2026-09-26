const axios = require('axios');
const { check: checkBudget } = require('./enrichmentBudget.cjs');

/**
 * The one place a paid Mapbox Directions request is made.
 *
 * Two callers with different needs, which is the reason this is a module rather
 * than a copied function:
 *
 *   the v3 distance slide  needs route GEOMETRY, because it draws the route
 *   the proximity backfill needs only km and minutes
 *
 * `overview: 'false'` drops the geometry, taking a response from ~2 KB to ~200
 * bytes. Across the backfill's ~29,000 legs that is ~50 MB not transferred, for a
 * field nothing would read.
 *
 * WHY DIRECTIONS AND NOT MATRIX. Matrix answers one origin against many
 * destinations in a single request, which would turn 27 calls per warehouse into
 * one. Measured on five real legs from a single origin, the two agreed exactly on
 * two and diverged 42-67% on the other three, with Matrix reporting a longer
 * distance and a shorter time each time — it prefers a ring-road route where
 * Directions takes the shorter city one. Since a shortlist is by construction a set
 * of candidates within 1.7x of each other, an error of that size across that spread
 * means Matrix would often pick the WRONG WINNER, and the bias is systematically
 * wrong for peripheral industrial belts, which is where warehouses are.
 */

const DEFAULT_TIMEOUT_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `driving` rather than `driving-traffic`. Traffic-aware times measured more
 * realistic (71 min against 87 on one leg) but vary with when the call is made, so
 * the same deck generated twice would disagree with itself. A stored number has to
 * be reproducible.
 */
const PROFILE = 'driving';
const PROVIDER = 'mapbox-directions';

/**
 * Token bucket. Directions allows roughly 300 requests a minute, and that ceiling
 * — not concurrency — is what bounds the backfill: five parallel legs measured
 * 726 ms, i.e. ~2,000/min of available parallelism. A worker pool alone would
 * therefore blow straight through the limit.
 */
class TokenBucket {
    constructor(perMinute) {
        this.intervalMs = perMinute > 0 ? 60000 / perMinute : 0;
        this.next = 0;
    }

    /** Reserves a slot before awaiting it, so N concurrent callers space out. */
    async take(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
        if (!this.intervalMs) return;
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + this.intervalMs;
        if (slot > now) await sleep(slot - now);
    }
}

/**
 * Transient conditions worth another attempt. A 429 in particular MUST NOT be
 * confused with "no route exists": persisting a throttled request as
 * ROUTING_FAILED records "you cannot drive there" when the truth is "we were rate
 * limited", and nothing would ever revisit it because the row looks computed.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000, 9000, 27000];

class DirectionsUnavailableError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'DirectionsUnavailableError';
        this.status = status;
        this.retryable = true;
    }
}

/**
 * One driving leg.
 *
 * THREE OUTCOMES, and the difference between the last two is the point:
 *   {km, minutes}  a route was found.
 *   null           Mapbox answered and there is genuinely no route — an island, a
 *                  pedestrian zone. A real fact about the pair of points.
 *   throws         we could not get an answer: throttled, server error, timeout.
 *                  The caller must NOT record this as a fact about the site; it has
 *                  to leave the warehouse uncomputed so a later run retries it.
 *
 * Retries the transient cases with backoff before giving up, honouring Retry-After
 * when Mapbox sends it.
 *
 * `alternatives` is deliberately never requested: measured, it CHANGES the primary
 * route returned (88.4 km/84 min against 62.0 km/97 min for one pair), so a stored
 * number would depend on a flag unrelated to the question.
 *
 * @param {string} token
 * @param {{lat: number, lng: number}} from
 * @param {{lat: number, lng: number}} to
 * @param {object} [opts]
 * @param {'false'|'simplified'|'full'} [opts.overview] - 'false' for numbers only
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.http] - injected for tests
 * @returns {Promise<{km: number, minutes: number, geometry: string|null}|null>}
 */
async function fetchLeg(token, from, to, {
    overview = 'false',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    http = null,
    // Injected in tests: the real backoff is deliberately slow, and a test that
    // waits 40 seconds for it will be deleted by whoever runs the suite next.
    sleepFn = sleep,
    retryDelaysMs = RETRY_DELAYS_MS,
    signal,
    requireValidResponse = false,
} = {}) {
    // Mapbox coordinates are lng,lat — the opposite order to how every row in this
    // codebase reads. Transposing them silently returns a plausible route between
    // two entirely different places.
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const geometryParam = overview === 'false' ? '' : '&geometries=polyline';
    const url = `https://api.mapbox.com/directions/v5/mapbox/${PROFILE}/${coords}`
        + `?overview=${overview}${geometryParam}&access_token=${token}`;

    const get = http || ((u, c) => axios.get(u, c));
    let lastStatus;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        checkBudget(signal);
        let res;
        try {
            // validateStatus lets a 429 body (and its Retry-After header) reach us
            // instead of arriving as a thrown error with the details buried.
            res = await get(url, { timeout: timeoutMs, validateStatus: () => true, ...(signal ? { signal } : {}) });
        } catch (err) {
            checkBudget(signal);
            // A network fault or timeout. Recoverable, so keep trying.
            lastStatus = err && err.response && err.response.status;
            if (attempt < retryDelaysMs.length) {
                await sleepFn(retryDelaysMs[attempt]);
                continue;
            }
            throw new DirectionsUnavailableError(
                `Directions request failed: ${err && err.message}`, lastStatus);
        }

        const status = res && res.status;
        if (status >= 400 && !RETRYABLE_STATUS.has(status) && status !== 422) {
            throw new DirectionsUnavailableError(`Directions returned HTTP ${status}`, status);
        }
        if (status !== undefined && RETRYABLE_STATUS.has(status)) {
            lastStatus = status;
            if (attempt < retryDelaysMs.length) {
                const advised = retryAfterMs(res.headers);
                await sleepFn(Math.max(advised || 0, retryDelaysMs[attempt]));
                continue;
            }
            throw new DirectionsUnavailableError(`Directions returned HTTP ${status}`, status);
        }

        const route = res && res.data && res.data.routes && res.data.routes[0];
        if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
            if (requireValidResponse && !['NoRoute', 'NoSegment'].includes(res?.data?.code)) {
                throw new DirectionsUnavailableError('Directions returned an invalid route response', status);
            }
            // Mapbox answered and found nothing. A genuine "not routable", which the
            // caller is entitled to record as such.
            return null;
        }
        return {
            km: route.distance / 1000,
            minutes: route.duration / 60,
            geometry: route.geometry || null,
        };
    }

    throw new DirectionsUnavailableError('Directions retries exhausted', lastStatus);
}

/** `Retry-After` is seconds or an HTTP date; ignore anything unparsable. */
function retryAfterMs(headers) {
    const raw = headers && (headers['retry-after'] || headers['Retry-After']);
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const when = Date.parse(raw);
    return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/**
 * Mapbox accepts up to 25 coordinates in one Directions request and bills the whole
 * thing as a SINGLE request.
 *
 * That is exploitable here, but not directly: a multi-waypoint route is a CHAIN
 * (origin -> A -> B), and what a warehouse needs is a STAR (origin -> A,
 * origin -> B). Interleaving the origin back in gives both:
 *
 *   origin -> A -> origin -> B -> origin -> C
 *   legs:     0      1        2      3        4
 *             ^outbound      ^outbound      ^outbound
 *
 * The even-indexed legs are the star distances; the odd ones are return trips we
 * discard. Verified against separate single-leg requests on real coordinates: the
 * per-leg distances matched to 0.000 km across every leg. So this is a pure cost
 * reduction with no accuracy trade, unlike the Matrix API, which is one request but
 * a different road model (measured 42-67% divergence).
 *
 * 2N+1 coordinates for N destinations, so 12 destinations fit in one request.
 */
const MAX_COORDS = 25;
const MAX_DESTS_PER_REQUEST = Math.floor((MAX_COORDS - 1) / 2);

/** Chunks of one warehouse's destinations that may be in flight together. */
const DEFAULT_CHUNK_CONCURRENCY = 6;

/**
 * Road distance and drive time from one origin to many destinations.
 *
 * @param {string} token
 * @param {{lat: number, lng: number}} origin
 * @param {Array<{lat: number, lng: number}>} destinations
 * @param {object} [opts] - as fetchLeg, plus `maxDests` for tests
 * @returns {Promise<Array<{km: number, minutes: number}|null>>} positionally
 *   aligned with `destinations`; null where no route exists.
 * @throws {DirectionsUnavailableError} when Mapbox could not be reached at all
 */
async function fetchLegsFrom(token, origin, destinations, opts = {}) {
    if (!destinations || !destinations.length) return [];
    // Awaited before every HTTP call. Only this function knows how many requests a
    // batch becomes, so the caller cannot rate-limit correctly from outside — and
    // because the gate reserves its slot before awaiting, concurrent chunks still
    // respect the overall rate.
    const gate = opts.onRequest || (() => Promise.resolve());

    const chunkSize = opts.maxDests || MAX_DESTS_PER_REQUEST;
    const concurrency = Math.max(1, opts.chunkConcurrency || DEFAULT_CHUNK_CONCURRENCY);
    const out = new Array(destinations.length).fill(null);

    const starts = [];
    for (let start = 0; start < destinations.length; start += chunkSize) starts.push(start);

    /** One chunk: the batched form, falling back to singles if the batch is refused. */
    const runChunk = async (start) => {
        const chunk = destinations.slice(start, start + chunkSize);

        // A single destination needs no interleaving, and the plain two-point form
        // is what fetchLeg already does well.
        if (chunk.length === 1) {
            await gate();
            out[start] = await fetchLeg(token, origin, chunk[0], opts);
            return;
        }

        await gate();
        const legs = await fetchInterleaved(token, origin, chunk, opts);
        if (legs) {
            legs.forEach((leg, i) => { out[start + i] = leg; });
            return;
        }

        // The batch failed as a batch. Mapbox rejects an entire multi-waypoint
        // request when ANY single waypoint is unroutable, so one island destination
        // would otherwise cost us the other eleven answers. Fall back to individual
        // legs for this chunk only.
        for (let i = 0; i < chunk.length; i++) {
            await gate();
            out[start + i] = await fetchLeg(token, origin, chunk[i], opts);
        }
    };

    // Chunks run concurrently rather than one after another. Processing them in
    // series made each warehouse pay four or five round trips end to end, which
    // dominated the backfill: measured at 7.8s per warehouse against roughly 1s of
    // actual rate-limited request time. The rate limiter, not this loop, is what
    // bounds the request rate.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= starts.length) return;
            await runChunk(starts[i]);
        }
    }));
    return out;
}

/**
 * One interleaved request.
 *
 * @returns {Promise<Array<{km, minutes}|null>|null>} null when the batch itself was
 *   rejected — the caller should retry the destinations individually.
 */
async function fetchInterleaved(token, origin, destinations, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    http = null,
    sleepFn = sleep,
    retryDelaysMs = RETRY_DELAYS_MS,
    signal,
    requireValidResponse = false,
} = {}) {
    const o = `${origin.lng},${origin.lat}`;
    const coords = [o];
    destinations.forEach((d) => { coords.push(`${d.lng},${d.lat}`); coords.push(o); });
    // The trailing return to the origin is unnecessary; dropping it saves a leg.
    coords.pop();

    const url = `https://api.mapbox.com/directions/v5/mapbox/${PROFILE}/${coords.join(';')}`
        + `?overview=false&access_token=${token}`;
    const get = http || ((u, c) => axios.get(u, c));

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        checkBudget(signal);
        let res;
        try {
            res = await get(url, { timeout: timeoutMs, validateStatus: () => true, ...(signal ? { signal } : {}) });
        } catch (err) {
            checkBudget(signal);
            if (attempt < retryDelaysMs.length) { await sleepFn(retryDelaysMs[attempt]); continue; }
            throw new DirectionsUnavailableError(
                `Directions batch failed: ${err && err.message}`, err && err.response && err.response.status);
        }

        if (res?.status >= 400 && !RETRYABLE_STATUS.has(res.status) && res.status !== 422) {
            throw new DirectionsUnavailableError(`Directions batch returned HTTP ${res.status}`, res.status);
        }
        if (res && RETRYABLE_STATUS.has(res.status)) {
            if (attempt < retryDelaysMs.length) {
                const advised = retryAfterMs(res.headers);
                await sleepFn(Math.max(advised || 0, retryDelaysMs[attempt]));
                continue;
            }
            throw new DirectionsUnavailableError(`Directions batch returned HTTP ${res.status}`, res.status);
        }

        const legs = res && res.data && res.data.routes && res.data.routes[0]
            && res.data.routes[0].legs;
        // Expected legs for N destinations after dropping the trailing return: 2N-1.
        if (!Array.isArray(legs) || legs.length !== destinations.length * 2 - 1) {
            if (requireValidResponse && !['NoRoute', 'NoSegment'].includes(res?.data?.code)) {
                throw new DirectionsUnavailableError('Directions returned an invalid batch response', res?.status);
            }
            return null;   // rejected as a batch, or an unexpected shape
        }

        return destinations.map((_, i) => {
            const leg = legs[i * 2];
            if (!leg || !Number.isFinite(leg.distance) || !Number.isFinite(leg.duration)) {
                if (requireValidResponse) throw new DirectionsUnavailableError('Directions returned an invalid batch leg', res?.status);
                return null;
            }
            return { km: leg.distance / 1000, minutes: leg.duration / 60, geometry: null };
        });
    }
    return null;
}

module.exports = {
    fetchLeg, fetchLegsFrom, MAX_DESTS_PER_REQUEST, DEFAULT_CHUNK_CONCURRENCY, TokenBucket, PROFILE, PROVIDER, DEFAULT_TIMEOUT_MS,
    DirectionsUnavailableError, RETRYABLE_STATUS, RETRY_DELAYS_MS,
};
