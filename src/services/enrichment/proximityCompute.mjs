import categories from '../../lib/proximity/proximityCategories.cjs';
import shortlist from '../../lib/proximity/proximityShortlist.cjs';
import directions from '../../lib/proximity/mapboxDirections.cjs';
import budget from '../../lib/proximity/enrichmentBudget.cjs';
const { METRIC_IDENTITY } = categories;
const { guardCandidates, resolve } = shortlist;
const { fetchLegsFrom, TokenBucket, PROFILE, PROVIDER } = directions;
const { check, sleep } = budget;
export class ProximityComputer {
  constructor(model, route = fetchLegsFrom) { this.model = model; this.route = route; this.bucket = new TokenBucket(120); }
    async compute(warehouse, categories, watermarks, signal) {
        if (!categories.length) return [];
        check(signal);
        const poiCategories = categories.filter(c => c.metric !== METRIC_IDENTITY);
        const shortlists = new Map();
        const pois = await this.model.bounded('nearestPois', warehouse, poiCategories);
        for (const poi of pois) {
            if (!shortlists.has(poi.category)) shortlists.set(poi.category, []);
            shortlists.get(poi.category).push(poi);
        }
        for (const category of categories.filter(c => c.metric === METRIC_IDENTITY)) {
            check(signal);
            shortlists.set(category.key, await this.model.bounded('nearestHighway', warehouse, category.maxRadiusKm));
        }
        const entries = categories.map(category => ({ category,
            candidates: guardCandidates(shortlists.get(category.key) || []), legs: [] }));
        const jobs = entries.flatMap(entry => entry.category.metric === METRIC_IDENTITY ? []
            : entry.candidates.map(candidate => ({ entry, candidate })));
        const legs = await this.route(process.env.MAPBOX_ACCESS_TOKEN, warehouse,
            jobs.map(j => ({ lat: j.candidate.lat, lng: j.candidate.lng })), {
                signal, timeoutMs: 8000, retryDelaysMs: [], chunkConcurrency: 1, requireValidResponse: true,
                onRequest: async () => {
                    check(signal);
                    await this.bucket.take(ms => sleep(ms, signal));
                    check(signal);
                },
            });
        jobs.forEach((job, i) => job.entry.legs.push(legs[i]));
        return entries.map(({ category, candidates, legs: routes }) => ({
            category: category.key, ...resolve({ category, candidates, legs: routes }),
            provider: category.metric === METRIC_IDENTITY ? null : PROVIDER,
            profile: category.metric === METRIC_IDENTITY ? null : PROFILE,
            computedFromLat: warehouse.lat, computedFromLng: warehouse.lng,
            poiWatermark: watermarks.get(category.key) || null,
        }));
    }
}
