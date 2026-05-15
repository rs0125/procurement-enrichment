import "dotenv/config";
import { writeFileSync, existsSync, readFileSync } from "fs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// --- Config ---
const DELAY_BETWEEN_REQUESTS_MS = 2000; // 2s between each geocode
const DELAY_BETWEEN_BATCHES_MS = 10000; // 10s pause every batch
const BATCH_SIZE = 15; // re-warm session every 15 requests
const CSV_PATH = "output/warehouses_geocoded.csv";
const PROGRESS_PATH = "output/.geocode_progress.json"; // resume support

// --- Cookie / session setup ---
const BASE_COOKIE =
  "CONSENT=YES+; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpXzIwMjMwMTEwLjA3X3AxLjhmGgJlbiACGgYIgLCjnwY;";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Cookie: BASE_COOKIE,
  DNT: "1",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

async function warmUpSession() {
  const r = await fetch("https://www.google.com/maps", {
    redirect: "follow",
    headers: BROWSER_HEADERS,
  });
  const setCookies = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");
  BROWSER_HEADERS.Cookie = BASE_COOKIE + " " + setCookies;
}

async function resolveViaCid(ftid) {
  const pbUrl =
    `https://www.google.com/maps/preview/place?authuser=0&hl=en&gl=in` +
    `&pb=!1m17!1s${ftid}!3m12!1m3!1d10000!2d77.5!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!4m2!3d13.0!4d77.5`;

  const r = await fetch(pbUrl, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: "https://www.google.com/maps",
    },
  });

  if (r.status !== 200) return null;

  const text = await r.text();
  const match = text.match(/\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/);
  if (match) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  return null;
}

function extractCoordsFromString(str) {
  const m1 = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]), via: "url_@" };

  const m3 = str.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]), via: "url_!3d!4d" };

  const m2 = str.match(/\/search\/(-?\d+\.?\d*),\s*\+?(-?\d+\.?\d*)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]), via: "url_/search/" };

  const m4 = str.match(/ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m4) return { lat: parseFloat(m4[1]), lng: parseFloat(m4[2]), via: "url_ll=" };

  const m5 = str.match(/q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m5) return { lat: parseFloat(m5[1]), lng: parseFloat(m5[2]), via: "url_q=" };

  const dms = str.match(
    /(\d+)%C2%B0(\d+)'([\d.]+)%22([NS])\+(\d+)%C2%B0(\d+)'([\d.]+)%22([EW])/
  );
  if (dms) {
    let lat = parseFloat(dms[1]) + parseFloat(dms[2]) / 60 + parseFloat(dms[3]) / 3600;
    let lng = parseFloat(dms[5]) + parseFloat(dms[6]) / 60 + parseFloat(dms[7]) / 3600;
    if (dms[4] === "S") lat = -lat;
    if (dms[8] === "W") lng = -lng;
    return { lat, lng, via: "url_dms" };
  }

  return null;
}

async function extractCoordinatesFromUrl(url) {
  let finalUrl = url;

  // Step 1: Resolve shortened URLs
  if (url.includes("goo.gl") || url.includes("share.google")) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: BROWSER_HEADERS,
      });
      finalUrl = response.url;
    } catch {
      return { lat: null, lng: null, via: "error_resolve" };
    }
  }

  // Step 2: Try URL pattern extraction
  const urlCoords = extractCoordsFromString(finalUrl);
  if (urlCoords) return urlCoords;

  // Step 3: CID lookup via preview/place API
  const ftidMatch = finalUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/);
  if (ftidMatch) {
    try {
      const cidCoords = await resolveViaCid(ftidMatch[1]);
      if (cidCoords) return { ...cidCoords, via: "cid_lookup" };
    } catch {
      return { lat: null, lng: null, via: "error_cid" };
    }
  }

  return { lat: null, lng: null, via: "no_match" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeCsvField(val) {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function loadProgress() {
  if (existsSync(PROGRESS_PATH)) {
    return JSON.parse(readFileSync(PROGRESS_PATH, "utf-8"));
  }
  return { completedIds: [], results: [] };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress));
}

function writeCsv(results) {
  const header = "warehouse_id,google_maps_url,latitude,longitude,method";
  const rows = results.map((r) =>
    [
      r.id,
      escapeCsvField(r.googleLocation),
      r.lat ?? "",
      r.lng ?? "",
      r.via,
    ].join(",")
  );
  writeFileSync(CSV_PATH, header + "\n" + rows.join("\n") + "\n");
}

async function main() {
  // Ensure output dir exists
  const { mkdirSync } = await import("fs");
  mkdirSync("output", { recursive: true });

  // Load progress for resume support
  const progress = loadProgress();
  const completedSet = new Set(progress.completedIds);

  console.log("=== Warehouse Geocoder ===\n");

  // Warm up session
  console.log("Warming up Google Maps session...");
  await warmUpSession();
  console.log("Session ready.\n");

  // Fetch all warehouses with googleLocation
  console.log("Querying database...");
  const warehouses = await prisma.warehouse.findMany({
    where: { googleLocation: { not: null } },
    select: { id: true, googleLocation: true },
    orderBy: { id: "asc" },
  });

  const valid = warehouses.filter(
    (w) => w.googleLocation && w.googleLocation.trim() !== ""
  );

  console.log(`Total warehouses: ${warehouses.length}`);
  console.log(`With googleLocation: ${valid.length}`);
  console.log(`Already completed: ${completedSet.size}`);

  const pending = valid.filter((w) => !completedSet.has(w.id));
  console.log(`Pending: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log("Nothing to do. Writing CSV from existing progress...");
    writeCsv(progress.results);
    console.log(`CSV written to ${CSV_PATH}`);
    return;
  }

  // Diagnostics counters
  const stats = { url_match: 0, cid_lookup: 0, failed: 0, errors: 0 };
  let batchCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const w = pending[i];
    batchCount++;

    // Re-warm session every BATCH_SIZE requests
    if (batchCount > BATCH_SIZE) {
      console.log(`\n--- Batch pause (${DELAY_BETWEEN_BATCHES_MS / 1000}s) + session refresh ---`);
      await sleep(DELAY_BETWEEN_BATCHES_MS);
      await warmUpSession();
      batchCount = 1;
    }

    const pct = (((completedSet.size + 1) / valid.length) * 100).toFixed(1);
    process.stdout.write(
      `[${completedSet.size + 1}/${valid.length} ${pct}%] #${w.id} `
    );

    const result = await extractCoordinatesFromUrl(w.googleLocation);

    const row = {
      id: w.id,
      googleLocation: w.googleLocation,
      lat: result.lat,
      lng: result.lng,
      via: result.via,
    };

    progress.results.push(row);
    progress.completedIds.push(w.id);
    completedSet.add(w.id);

    // Track stats
    if (result.via?.startsWith("url_")) stats.url_match++;
    else if (result.via === "cid_lookup") stats.cid_lookup++;
    else if (result.via?.startsWith("error")) stats.errors++;
    else stats.failed++;

    const coordStr = result.lat ? `${result.lat}, ${result.lng}` : "FAILED";
    console.log(`=> ${coordStr} (${result.via})`);

    // Save progress every 10 entries
    if (progress.results.length % 10 === 0) {
      saveProgress(progress);
    }

    // Delay between requests
    if (i < pending.length - 1) {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  // Final save
  saveProgress(progress);
  writeCsv(progress.results);

  // Diagnostics
  const total = progress.results.length;
  const succeeded = progress.results.filter((r) => r.lat != null).length;
  const failedTotal = total - succeeded;

  console.log("\n========================================");
  console.log("            DIAGNOSTICS");
  console.log("========================================\n");
  console.log(`Total warehouses with URLs:  ${total}`);
  console.log(`Successfully geocoded:       ${succeeded} (${((succeeded / total) * 100).toFixed(1)}%)`);
  console.log(`Failed:                      ${failedTotal} (${((failedTotal / total) * 100).toFixed(1)}%)`);
  console.log();
  console.log("Breakdown by method:");
  console.log(`  URL pattern match:         ${stats.url_match}`);
  console.log(`  CID lookup (API):          ${stats.cid_lookup}`);
  console.log(`  No match:                  ${stats.failed}`);
  console.log(`  Errors:                    ${stats.errors}`);
  console.log();
  console.log(`CSV written to: ${CSV_PATH}`);
  console.log(`Progress file:  ${PROGRESS_PATH} (delete to re-run from scratch)`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
