const crypto = require('crypto');

/**
 * The POI ingest's category definitions — the single source of truth for what is
 * fetched, how, and what counts as a plausible result.
 *
 * The script, the tests and the queryHash all read from here. If a query string
 * lived inline in the script instead, the stored hash could drift from what was
 * actually sent, and the "a changed query refetches its tiles" guarantee would
 * quietly stop holding.
 *
 * ---------------------------------------------------------------------------
 * Why most categories are fetched nationally in one request
 * ---------------------------------------------------------------------------
 * The original plan tiled everything to a 0.5-degree grid around our warehouses:
 * 120 tiles x 11 categories = 1,320 requests. Measuring the national counts first
 * showed that was the wrong shape. At ~600 bytes per element, ten of the eleven
 * categories fit in a single national request each:
 *
 *   aerodrome 401 · fire_station 733 · seaport 960 · motorway_junction 1,374
 *   police 4,466 · city/town 4,651 · bus_station 6,225 · railway_station 10,231
 *
 * (substation was ingested and then dropped: 17,047 rows of which the filter
 * kept 9,605, but 79% were unnamed, and "nearest substation: unnamed, 6 km" is
 * not a fact worth putting on a proposal. Restoring it is a git revert.)
 *   fuel 19,087                            -> 59 MB of JSON in total
 *   hospital 55,539 (32 MB)                -> the only one needing a split
 *
 * So SCOPE_NATIONAL is the default. It is fewer requests, it is kinder to a
 * donated server, and — the real reason — it removes a whole class of bug: a
 * warehouse-derived tile grid only covers the country where we happen to own
 * listings today, so "nearest fire station" is silently bounded by our own
 * footprint, and every new warehouse outside it needs a fresh ingest before its
 * proximity can be computed. A national fetch has no edge.
 *
 * Highways are the exception, and it is a measured one: `out geom` returned
 * 2.6 MB for a single 1-degree tile around Bengaluru, so full national highway
 * geometry is on the order of 2.6 GB. That is too much to pull from a public
 * instance, so the two highway categories stay restricted to a buffer around our
 * warehouses. Their coverage therefore IS bounded by our footprint, and the
 * ingest records that honestly rather than pretending otherwise.
 */

const SCOPE_NATIONAL = 'national';   // one request, whole country
const SCOPE_GRID = 'grid';           // fixed national grid, for categories too big for one request
const SCOPE_FOOTPRINT = 'footprint'; // tiles derived from warehouse coordinates

const TARGET_POI = 'osm_poi';
const TARGET_HIGHWAY = 'osm_highway';

/** Restricts a query to India. Kept in one place so every query agrees. */
const AREA_IN = 'area["ISO3166-1"="IN"][admin_level=2]->.in;';

/**
 * Coverage radius, in km, that each footprint-scoped category must guarantee
 * around every warehouse. The fetch box is the tile expanded by this much, so it
 * has to be at least the search radius the proximity step will later use — or the
 * search finds nothing outside the box and records a confident, wrong
 * "none in range".
 *
 * National and grid categories don't need this: they cover the country.
 */
const FOOTPRINT_RADIUS_KM = 25;

/** Degrees of latitude per km, near enough at these latitudes for a fetch buffer. */
const DEG_PER_KM = 1 / 111;

/**
 * Numbered-highway refs worth storing, as an Overpass regex.
 *
 * NH national highway, NE expressway, AH Asian Highway, SH state highway.
 *
 * SH is included DELIBERATELY, which it previously was not. The earlier pattern
 * accepted only NH/NE/AH on `highway=primary` while accepting any ref on `trunk`,
 * and the measured result was 12,858 NH rows against 573 SH — those 573 being
 * simply the state highways OSM happens to tag as trunk. That is the worst of both
 * options: "nearest highway" would almost always find an NH and would find an SH
 * only by luck. A state highway is a real access route for a warehouse, so either
 * include them properly or not at all.
 *
 * The stored `ref` is what distinguishes them downstream ("NH44" vs "SH17"), so a
 * reader can prefer one class over the other, or label them differently. The OSM
 * `highway` class cannot do that job: it is motorway/trunk/primary, which in India
 * does not map cleanly onto the NH/SH distinction.
 */
const HIGHWAY_REF_PATTERN = '^(NH|NE|AH|SH)[ -]?[0-9]';

/**
 * Preference order when a road carries more than one designation. An Indian
 * reader recognises "NH44" far more readily than its Asian Highway alias "AH43",
 * and an expressway is the more useful fact when a road is both.
 */
const REF_CLASS_RANK = { NE: 0, NH: 1, SH: 2, AH: 3, MDR: 4, ODR: 5 };

/**
 * Canonicalise an OSM highway `ref` into one preferred designation plus the full
 * set of them.
 *
 * Two measured problems this solves. 641 of 15,724 ways carried more than one
 * designation in a single semicolon-separated string ("NH44;NH75"), so anything
 * parsing that column naively gets a value that is neither designation and matches
 * no query. And OSM spells the same road inconsistently — "NH44", "NH 44",
 * "NH-44" are all present — so grouping or matching on the raw string silently
 * treats one highway as three.
 *
 * @param {string|null|undefined} raw - the OSM ref tag
 * @returns {{ref: string|null, refs: string[]}} `ref` is the one to display;
 *   `refs` is every designation, canonical and deduplicated, for matching.
 */
function parseRefs(raw) {
    if (raw === null || raw === undefined) return { ref: null, refs: [] };

    const seen = new Set();
    const parsed = [];
    for (const piece of String(raw).split(/[;,]/)) {
        // Collapse "NH 44" / "NH-44" / "nh44" to "NH44". The prefix and number are
        // captured separately so anything not shaped like a designation is kept
        // verbatim rather than mangled into one.
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const m = /^([A-Za-z]{2,3})[\s-]*([0-9]+[A-Za-z]?)$/.exec(trimmed);
        const canonical = m ? `${m[1].toUpperCase()}${m[2].toUpperCase()}` : trimmed;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const cls = m ? m[1].toUpperCase() : null;
        parsed.push({
            canonical,
            rank: cls !== null && cls in REF_CLASS_RANK ? REF_CLASS_RANK[cls] : 9,
            number: m ? parseInt(m[2], 10) : Number.MAX_SAFE_INTEGER,
        });
    }
    if (!parsed.length) return { ref: null, refs: [] };

    // Sorted for display preference; the tie-break on number only exists so the
    // choice is deterministic across runs rather than dependent on OSM's ordering.
    const preferred = [...parsed].sort((a, b) => a.rank - b.rank || a.number - b.number)[0];
    return { ref: preferred.canonical, refs: parsed.map((r) => r.canonical) };
}

/**
 * Names that only restate the category, so they tell a reader nothing.
 *
 * These are not placeholders we invented — they are real OSM `name` tags, from
 * mappers who put the category in the name field. Measured across the ingest: 32
 * fuel stations named "Fuel", 25 hospitals named "Hospital", 8 bus stations named
 * "Bus Station". "Nearest fuel station: Fuel" reads as a bug on a proposal, and it
 * is strictly less useful than admitting the place is unnamed.
 *
 * Deliberately narrow: only names that are exactly a category word. "Government
 * Hospital, Karpuru" and "Anekal Bus Stand" are informative and stay.
 */
const UNINFORMATIVE_NAMES = new Set([
    'fuel', 'petrol', 'petrol pump', 'petrol station', 'fuel station', 'gas station',
    'hospital', 'clinic', 'health centre', 'health center',
    'bus station', 'bus stand', 'bus terminal',
    'railway station', 'train station', 'station', 'railway',
    'airport', 'aerodrome', 'airstrip',
    'police', 'police station', 'fire station', 'fire brigade',
    'substation', 'power substation', 'port', 'harbour', 'harbor',
    'highway', 'road', 'unnamed', 'unknown', 'n/a', 'na', 'none',
]);

/**
 * A usable display name, or null.
 *
 * NEVER a placeholder. The code this ingest replaces did
 * `element.tags?.name || 'Railway Station'`, which is how fifty POIs end up sharing
 * one name and a deck looks like it knows something it does not. Null, and let the
 * renderer say "unnamed".
 */
function nameFrom(tags = {}) {
    const candidate = tags.name || tags['name:en'] || tags.ref || null;
    if (!candidate) return null;
    const trimmed = String(candidate).trim();
    if (!trimmed.length) return null;
    if (UNINFORMATIVE_NAMES.has(trimmed.toLowerCase())) return null;
    return trimmed;
}

/** Largest voltage in an OSM `voltage` tag, which may be `220000;110000`. */
function maxVoltage(raw) {
    if (!raw) return null;
    const volts = String(raw).split(';')
        .map((v) => Number(String(v).trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
    return volts.length ? Math.max(...volts) : null;
}

/**
 * Categories, in ingest order: cheap national fetches first, so a run that has to
 * be interrupted has already banked the easy wins.
 *
 * Each entry:
 *   key        - stored in osm_poi.category. Matches the existing live values
 *                (`hospital`, `fuel`) and the frontend palette names in
 *                Frontend_Repository/src/utils/geoIcons.js where one exists, so
 *                map colours land without a frontend change.
 *   scope      - SCOPE_NATIONAL | SCOPE_GRID | SCOPE_FOOTPRINT
 *   target     - which table the rows go to
 *   ql(box)    - complete Overpass QL. `box` is null for a national fetch, or an
 *                "s,w,n,e" string otherwise.
 *   keep(el)   - post-filter. Overpass cannot express everything we need.
 *   minExpected             - a national floor; below it the fetch is a failure,
 *                            not an empty result (see the note on area lookups).
 *   mustExistNearWarehouses - if this comes back empty for a cell containing a
 *                            warehouse, that is a hard suspect, not a fact.
 */
const CATEGORIES = [
    {
        key: 'aerodrome',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 300,
        minExpected: 120,
        mustExistNearWarehouses: false,
        /**
         * An IATA code is the whole filter, and the narrowness is deliberate.
         *
         * Measured: 401 bare `aeroway=aerodrome` exist in India but only 158 carry
         * an IATA code. The other 243 are gliding clubs, private strips and military
         * airfields — none of them somewhere freight goes.
         *
         * An earlier version also accepted `aerodrome:type=public|international|
         * regional`, on the theory that some real airports lack an IATA code. Checked
         * against the ingested data, that clause contributed exactly 2 of 171 rows,
         * and one of them was Jakkur Aerodrome — a flying club that then came back as
         * the nearest airport to a Bengaluru warehouse, 41 km away, in place of
         * Kempegowda International. Every commercial Indian airport has an IATA code,
         * so the clause bought two rows and one wrong answer.
         *
         * This query is still the biggest quality win in the ingest. It replaces
         * geospatialService.findNearestAirport, which is a Nominatim FREE-TEXT
         * SEARCH for the word "airport" in a +/-1 degree box — it can and does return
         * "Airport Road" and airport hotels.
         */
        ql: () => `[out:json][timeout:300];
${AREA_IN}
nwr["aeroway"="aerodrome"]["iata"](area.in);
out center;`,
    },

    {
        key: 'fire_station',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 300,
        minExpected: 400,
        mustExistNearWarehouses: false,
        ql: () => `[out:json][timeout:300];
${AREA_IN}
nwr["amenity"="fire_station"](area.in);
out center;`,
    },

    {
        key: 'seaport',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 300,
        minExpected: 20,
        mustExistNearWarehouses: false,
        /**
         * Deliberately excludes `amenity=ferry_terminal`: a passenger jetty is not
         * a port, and calling one "nearest port" on a logistics proposal is wrong.
         *
         * NOTE: this covers seaports only. Inland Container Depots and Container
         * Freight Stations — the ones a warehouse client actually asks about — have
         * NO OpenStreetMap tagging. There is no honest way to ingest them here; see
         * the ICD/CFS note in the plan. Do not "fix" this by adding a
         * name-regex over landuse=industrial: it misses most of the ~60 CONCOR ICDs
         * and invents false positives, which is worse than admitting the gap.
         */
        ql: () => `[out:json][timeout:300];
${AREA_IN}
(
  nwr["industrial"="port"](area.in);
  nwr["harbour"="yes"](area.in);
  nwr["seamark:type"="harbour"](area.in);
  nwr["industrial"="container_terminal"](area.in);
);
out center;`,
    },

    {
        key: 'city_centre',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 300,
        minExpected: 3000,
        mustExistNearWarehouses: false,
        /** Also the input to the free bad-coordinate check: nearest city vs stored city. */
        ql: () => `[out:json][timeout:300];
${AREA_IN}
(
  node["place"="city"](area.in);
  node["place"="town"](area.in);
);
out;`,
    },

    {
        key: 'police',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 600,
        minExpected: 2000,
        mustExistNearWarehouses: true,
        ql: () => `[out:json][timeout:600];
${AREA_IN}
nwr["amenity"="police"](area.in);
out center;`,
    },

    {
        key: 'bus_station',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 600,
        minExpected: 3000,
        mustExistNearWarehouses: true,
        /**
         * Excludes `highway=bus_stop`. India has 200k+ of those and a bus stop is
         * not a bus station — folding them in would make the stored distance answer
         * a different question from the label. If "can labour reach this site by
         * bus" is ever the real question, that is its own category.
         */
        ql: () => `[out:json][timeout:600];
${AREA_IN}
(
  nwr["amenity"="bus_station"](area.in);
  nwr["public_transport"="station"]["bus"="yes"](area.in);
);
out center;`,
    },

    {
        key: 'railway_station',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 600,
        minExpected: 6000,
        mustExistNearWarehouses: true,
        /**
         * Metro/light rail excluded: they are irrelevant to freight and would often
         * be the nearest "station" in exactly the cities where it matters least.
         * Overpass negation misses some tag combinations, so keep() catches the rest.
         *
         * Freight specifically is NOT available: OSM has no consistent tagging for
         * goods sheds or freight terminals in India, and most CONCOR rail terminals
         * are unmapped. `usage` and `operator` are kept in tags so a later pass can
         * filter without a re-ingest.
         */
        ql: () => `[out:json][timeout:600];
${AREA_IN}
(
  nwr["railway"="station"](area.in);
  nwr["railway"="halt"](area.in);
);
out center;`,
        keep: (el) => {
            const t = el.tags || {};
            if (t.subway === 'yes' || t.light_rail === 'yes' || t.monorail === 'yes') return false;
            return !/^(subway|light_rail|monorail)$/.test(t.station || '');
        },
    },

    {
        key: 'metro_station',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 600,
        minExpected: 300,
        mustExistNearWarehouses: false,
        /**
         * Metro, light rail and monorail stations — the ones `railway_station`
         * deliberately excludes.
         *
         * Previously these were fetched and thrown away: 1,112 of the 10,618
         * elements that query returned, discarded because folding a metro stop into
         * "nearest railway station" makes the number answer a different question
         * from its label, and would have made a metro stop the nearest "station" in
         * exactly the cities where that matters least for freight.
         *
         * They are worth keeping under their own name though, because they answer a
         * real question the freight one does not: whether staff can reach the site
         * without a car. Kept separate so neither number pretends to be the other.
         *
         * NOT marked mustExistNearWarehouses: metro exists in about a dozen Indian
         * cities, so a region without one is a fact, not a failed fetch.
         *
         * Every tag test is exact equality — a regex here cannot use Overpass's tag
         * index and measured 8.7x slower elsewhere in this file.
         */
        ql: () => `[out:json][timeout:600];
${AREA_IN}
(
  nwr["railway"="station"]["station"="subway"](area.in);
  nwr["railway"="station"]["station"="light_rail"](area.in);
  nwr["railway"="station"]["station"="monorail"](area.in);
  nwr["railway"="station"]["subway"="yes"](area.in);
  nwr["railway"="station"]["light_rail"="yes"](area.in);
  nwr["railway"="station"]["monorail"="yes"](area.in);
);
out center;`,
        /**
         * The exact inverse of railway_station's filter, so the two categories
         * partition the station set rather than overlapping or leaving a gap.
         */
        keep: (el) => {
            const t = el.tags || {};
            if (t.subway === 'yes' || t.light_rail === 'yes' || t.monorail === 'yes') return true;
            return /^(subway|light_rail|monorail)$/.test(t.station || '');
        },
    },

    {
        key: 'fuel',
        scope: SCOPE_NATIONAL,
        target: TARGET_POI,
        timeoutSec: 900,
        minExpected: 8000,
        mustExistNearWarehouses: true,
        /** `fuel:HGV_diesel` and `hgv` are kept in tags: "nearest pump that serves a truck" is the real question. */
        ql: () => `[out:json][timeout:900];
${AREA_IN}
nwr["amenity"="fuel"](area.in);
out center;`,
    },

    {
        key: 'hospital',
        scope: SCOPE_GRID,
        gridDeg: 6,
        target: TARGET_POI,
        timeoutSec: 900,
        minExpected: 20000,
        mustExistNearWarehouses: true,
        /**
         * The only category too large for one request — 55,539 nationally, ~32 MB —
         * so it is fetched on a coarse national grid instead. Grid cells are still
         * area-filtered to India, so ocean cells return immediately.
         *
         * Deliberately excludes `amenity=clinic|doctors`: folding a primary health
         * centre into "nearest hospital" makes the number answer a different
         * question from its label. A separate `clinic` category is cheap to add
         * later — the frontend palette already has a colour for it.
         *
         * Worth an eyeball on first ingest: 55,539 `amenity=hospital` is loose
         * tagging for India, so some of these will be small clinics regardless.
         */
        ql: (box) => `[out:json][timeout:900];
${AREA_IN}
(
  nwr["amenity"="hospital"](area.in)(${box});
  nwr["healthcare"="hospital"](area.in)(${box});
);
out center;`,
    },

    {
        key: 'highway_access',
        scope: SCOPE_FOOTPRINT,
        target: TARGET_POI,
        timeoutSec: 300,
        minExpected: 0,
        mustExistNearWarehouses: false,
        /**
         * Where you can actually get ON a national highway — not the nearest point
         * of tarmac. A warehouse 200 m from an expressway with no entrance for 15 km
         * is badly served by a distance-to-carriageway number, and that distinction
         * is the whole reason this is separate from `national_highway`.
         *
         * `node.ln.mn` is a set intersection: nodes belonging to both a ramp and a
         * mainline, i.e. the physical entry and exit points. `motorway_junction`
         * nodes are unioned in as well.
         *
         * EVERY TAG TEST HERE IS EXACT EQUALITY, NOT A REGEX, AND THAT MATTERS.
         * Overpass cannot use its tag index for a pattern match, so it scans
         * instead. Measured on the same 1-degree Bengaluru box, returning
         * byte-identical results both ways:
         *
         *   way["highway"~"^(motorway|trunk)_link$"]  41.4 s   (~82 min for 120 tiles)
         *   way["highway"="motorway_link"] + "trunk_link"   4.8 s   (~10 min)
         *
         * 8.7x, for nothing but spelling the query out. Please do not "tidy" these
         * four clauses back into two regexes.
         *
         * Also measured, before anyone builds a label from this: of those 658
         * access points only 6 carried a `ref` tag and 23 had any name. Access
         * points in India are essentially unnamed, so a display label should come
         * from the nearest `national_highway` ref, not from the node itself.
         */
        ql: (box) => `[out:json][timeout:300];
(
  way["highway"="motorway_link"](${box});
  way["highway"="trunk_link"](${box});
)->.links;
(
  way["highway"="motorway"](${box});
  way["highway"="trunk"](${box});
)->.mains;
node(w.links)->.ln;
node(w.mains)->.mn;
(
  node.ln.mn;
  node["highway"="motorway_junction"](${box});
);
out;`,
    },

    {
        key: 'national_highway',
        scope: SCOPE_FOOTPRINT,
        target: TARGET_HIGHWAY,
        timeoutSec: 300,
        minExpected: 0,
        mustExistNearWarehouses: false,
        /**
         * Numbered-highway centrelines, as LineStrings in osm_highway.
         *
         * Not points, and not in osm_poi: distance to a road is distance to a line.
         * The current export takes a way's bbox CENTRE (geospatialService.js
         * `out center` on highways), which for a 200 km trunk road can be 100 km
         * from the warehouse — the worst number in the deck today.
         *
         * Measured: `out geom` returns FULL, unclipped way geometry (817 of 26,385
         * vertices fell outside the requested box), so a way fetched from two
         * adjacent tiles is byte-identical and upserts onto one row — which is why
         * osm_highway is unique on (osmType, osmId) with no tile component.
         *
         * Also measured: 2.6 MB for one 1-degree tile. That is why this category is
         * footprint-scoped rather than national — full national geometry would be
         * roughly 2.6 GB.
         *
         * Two size decisions, both measured on real rows:
         *
         * `dropTags` — the tag blob cost 252 bytes a row, more than the geometry,
         * and ref/highway/name are already columns. Unlike a POI tag blob (where
         * `iata` separates an airport from an airstrip, and `voltage` a transmission
         * substation from a pole transformer) there is nothing in a highway's tags
         * that a reader needs.
         *
         * `simplifyDeg` — Overpass returns about 13 vertices a way. Simplified at
         * this tolerance that becomes 3, removing 75% of the geometry, and the
         * effect on the only thing the geometry is for — distance from a point to
         * the road — measured at 0.3 m typically and 55 m worst case. Against a
         * figure reported in kilometres that is free.
         */
        dropTags: true,
        /** ~55 m, in degrees. See the note above for what it costs in accuracy. */
        simplifyDeg: 0.0005,
        /**
         * Bumped when SHARED normalisation changes what this category stores, since
         * queryHash cannot see into parseRefs or the WKT builder the way it sees
         * per-category settings. Opt-in and per-category on purpose: a global
         * version would invalidate every unrelated category too.
         *
         * 2 — refs are canonicalised and split into the `refs` array.
         */
        storageVersion: 2,
        ql: (box) => `[out:json][timeout:300];
(
  way["highway"="motorway"](${box});
  way["highway"="trunk"](${box});
  way["highway"="primary"]["ref"~"${HIGHWAY_REF_PATTERN}"](${box});
  way["highway"="secondary"]["ref"~"^SH[ -]?[0-9]"](${box});
);
out geom;`,
        keep: (el) => Array.isArray(el.geometry) && el.geometry.length >= 2,
    },
];

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** @returns {object|undefined} */
const categoryFor = (key) => BY_KEY.get(key);

/** All category keys, in ingest order. */
const categoryKeys = () => CATEGORIES.map((c) => c.key);

/**
 * Identifies the query definition a stored row was built from.
 *
 * The script writes this onto every fetch record. Editing a category's QL changes
 * its hash, which marks those records stale and makes the next run refetch them —
 * without it, a query edit silently leaves part of the table built from the old
 * definition, and nothing ever tells you.
 *
 * Covers keep() and the filter-bearing fields too, since changing those changes
 * what gets stored just as surely as changing the QL.
 *
 * @param {string} key
 * @returns {string} 12 hex characters
 */
function queryHash(key) {
    const c = categoryFor(key);
    if (!c) throw new Error(`Unknown OSM category: ${key}`);
    // Everything that changes what ends up in the table belongs here, not just what
    // changes the request — a row stored under a different simplification tolerance
    // is as stale as one fetched by a different query.
    //
    // But ONLY what is relevant to this category. Fields that are unset are omitted
    // rather than serialised as null, so adding a setting that a category does not
    // use leaves its hash untouched. That property matters more than it looks:
    // hashing the full shape unconditionally re-invalidated all eleven categories
    // when the highway settings were introduced, which would have thrown away
    // 110,731 already-fetched POI rows for no behavioural reason.
    const shape = {
        ql: c.ql(c.scope === SCOPE_NATIONAL ? null : '0,0,1,1'),
        scope: c.scope,
        gridDeg: c.gridDeg || null,
        target: c.target,
        keep: c.keep ? c.keep.toString() : null,
    };
    if (c.dropTags) shape.dropTags = true;
    if (c.simplifyDeg) shape.simplifyDeg = c.simplifyDeg;
    if (c.storageVersion) shape.storageVersion = c.storageVersion;
    return crypto.createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

/**
 * Degrees to expand a footprint tile by, so the fetched box covers everything
 * within FOOTPRINT_RADIUS_KM of any warehouse in that tile. Without this a
 * warehouse sitting on a tile edge gets almost no coverage on the far side, and
 * its "nearest" answer is bounded by an arbitrary grid line.
 */
const footprintBufferDeg = (radiusKm = FOOTPRINT_RADIUS_KM) => radiusKm * DEG_PER_KM;

module.exports = {
    CATEGORIES,
    parseRefs,
    UNINFORMATIVE_NAMES,
    SCOPE_NATIONAL,
    SCOPE_GRID,
    SCOPE_FOOTPRINT,
    TARGET_POI,
    TARGET_HIGHWAY,
    FOOTPRINT_RADIUS_KM,
    categoryFor,
    categoryKeys,
    queryHash,
    nameFrom,
    maxVoltage,
    footprintBufferDeg,
};
