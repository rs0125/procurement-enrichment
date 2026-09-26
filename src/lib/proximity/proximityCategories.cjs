const { TARGET_HIGHWAY, categoryFor } = require('./osmCategories.cjs');

/**
 * What "nearby" means, per landmark category, for the warehouse proximity backfill.
 *
 * Two kinds of answer live here, and the distinction is deliberate:
 *
 *   METRIC_ROAD     — the nearest one, measured by road: km and drive time.
 *   METRIC_IDENTITY — the nearest one, named but NOT measured.
 *
 * Highways are identity-only, and that is a correctness decision rather than a
 * shortcut. Measured on the ingested data, 95.5% of India's numbered-highway
 * mileage is `trunk` or `primary` — not access-controlled — so vehicles join it at
 * ordinary crossroads that OSM has no reason to mark. That means we can say *which*
 * highway is nearest with confidence, but any distance we quoted would be either
 * distance-to-carriageway (which you often cannot actually use) or
 * distance-to-ramp (which only exists for the 4.5% that are access-controlled).
 * "Nearest highway: NH-48" is fully supportable; a number next to it is not, yet.
 */

const METRIC_ROAD = 'road';
const METRIC_IDENTITY = 'identity';

/**
 * @typedef {object} ProximityCategory
 * @property {string} key            - matches osm_poi.category, or the highway category
 * @property {string} label          - how it reads on a deck. Prefixed "Nearest"
 *                                     because without it a row reads as though the
 *                                     warehouse has an airport rather than being
 *                                     near one, and the precision is worth the
 *                                     repetition.
 * @property {string} group          - section heading on the connectivity slide
 * @property {string} metric         - METRIC_ROAD | METRIC_IDENTITY
 * @property {number} maxRadiusKm    - beyond this we report "none in range" rather than
 *                                     a technically-nearest landmark nobody would drive to
 * @property {number} candidates     - how many to shortlist by straight line before routing
 * @property {number} order          - display order
 */

/**
 * Radii are generous where the category is genuinely sparse and tight where a
 * distant one would be meaningless. They are safe to set large because the POI
 * ingest is national: unlike a footprint-bounded dataset, there is no coverage edge
 * that would turn "nothing within 200 km" into an artefact of what we fetched.
 *
 * `candidates` is 1 for identity categories (nothing is measured, so the
 * straight-line nearest IS the answer) and 12 for everything routed.
 *
 * TWELVE, AND MEASURED RATHER THAN GUESSED. The shortlist exists because the
 * nearest by straight line is often not the nearest by road, and the first version
 * of this file used 2-3 on the reasoning that the reordering would be local. It is
 * not. Routing a deliberately over-wide shortlist (k=8, no ratio guard) across 40
 * warehouses and 346 category comparisons put the TRUE road-nearest at:
 *
 *   rank 1  78.3%     rank 5  1.7%
 *   rank 2  10.1%     rank 6  0.3%
 *   rank 3   5.2%     rank 7  1.7%
 *   rank 4   0.9%     rank 8  1.7%
 *
 * So the crow-flies nearest is wrong 21.7% of the time. Repeating the experiment at
 * k=16 showed the tail runs further than the first look could see — winners at ranks
 * 9, 11, 13, 14 and 16 — with miss rates of 12.1% at k=2, 6.9% at k=3, 4.6% at k=5,
 * 2.3% at k=8 and 1.7% at k=12.
 *
 * BUT K IS NOT WHAT PROTECTS THE ANSWER; the ratio guard is. Across both
 * experiments (692 comparisons) every single winner sat within 2.5x the nearest
 * candidate's straight-line distance, max observed 2.37x. Those far-rank winners are
 * in dense clusters where twenty hospitals sit at near-identical straight-line
 * distances, so the guard keeps them all; in open country the guard prunes to one or
 * two. k only has to be wide enough not to truncate before the guard does, which is
 * why 20 rather than an ever-larger number.
 *
 * Measured cost at k=20 on a 60-warehouse sample: 56% of shortlisted candidates are
 * pruned by the guard, leaving a median of 59 destinations per warehouse, which
 * batch into ~5.5 billed requests. Affordable only because of that batching — Mapbox
 * bills up to 25 coordinates as one request, so a wide shortlist costs requests in
 * proportion to ceil(survivors/12) rather than to k.
 */
const ROUTED_CANDIDATES = 20;
const CATEGORIES = [
    // METRIC_IDENTITY, and it stays that way even though a distance now exists.
    //
    // The metric describes what THE SWEEP can measure, not what the deck can show.
    // resolve() shortlists tagged points and routes to them, and for a highway that
    // means routing to an access node — measured at a median 1.31km error against
    // the truth, because OSM does not tag the crossroads where you join an
    // unrestricted road. So the sweep names the highway and stops, correctly.
    //
    // The real distance comes from a different producer entirely:
    // scripts/backfillHighwayEntry.js samples the centreline every 100m and routes
    // to every sample (~900 legs a warehouse, viable only on a local engine). It
    // writes roadKm onto the same row. The slide therefore keys off the STORED DATA
    // rather than this metric — see proximityRows — so both producers can write the
    // row and neither has to lie. Flipping this to METRIC_ROAD would make the sweep
    // route to a candidate whose lat/lng are null and overwrite good measurements
    // with garbage.
    { key: 'national_highway', label: 'Nearest highway',         group: 'Connectivity', metric: METRIC_IDENTITY, maxRadiusKm: 50,  candidates: 1,                 order: 1 },
    { key: 'aerodrome',        label: 'Nearest airport',         group: 'Connectivity', metric: METRIC_ROAD,     maxRadiusKm: 200, candidates: ROUTED_CANDIDATES, order: 2 },
    { key: 'railway_station',  label: 'Nearest railway station', group: 'Connectivity', metric: METRIC_ROAD,     maxRadiusKm: 100, candidates: ROUTED_CANDIDATES, order: 3 },
    { key: 'seaport',          label: 'Nearest port',            group: 'Connectivity', metric: METRIC_ROAD,     maxRadiusKm: 300, candidates: ROUTED_CANDIDATES, order: 4 },
    { key: 'city_centre',      label: 'Nearest city centre',     group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 100, candidates: ROUTED_CANDIDATES, order: 5 },
    { key: 'bus_station',      label: 'Nearest bus station',     group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: ROUTED_CANDIDATES, order: 6 },
    { key: 'hospital',         label: 'Nearest hospital',        group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: ROUTED_CANDIDATES, order: 7 },
    { key: 'fire_station',     label: 'Nearest fire station',    group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: ROUTED_CANDIDATES, order: 8 },
    { key: 'police',           label: 'Nearest police station',  group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 25,  candidates: ROUTED_CANDIDATES, order: 9 },
    { key: 'fuel',             label: 'Nearest fuel station',    group: 'Local',        metric: METRIC_ROAD,     maxRadiusKm: 15,  candidates: ROUTED_CANDIDATES, order: 10 },
];

/** Group order for rendering, so a slide need not hardcode it. */
const GROUPS = ['Connectivity', 'Local'];


const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** @returns {ProximityCategory|undefined} */
const proximityCategoryFor = (key) => BY_KEY.get(key);

const proximityKeys = () => CATEGORIES.map((c) => c.key);

/** Categories whose landmark lives in osm_highway rather than osm_poi. */
const isHighway = (key) => {
    const ingest = categoryFor(key);
    return !!ingest && ingest.target === TARGET_HIGHWAY;
};

/** Categories that need a routing call. */
const routedCategories = () => CATEGORIES.filter((c) => c.metric === METRIC_ROAD);

module.exports = {
    CATEGORIES,
    GROUPS,
    METRIC_ROAD,
    METRIC_IDENTITY,
    proximityCategoryFor,
    proximityKeys,
    routedCategories,
    isHighway,
};
