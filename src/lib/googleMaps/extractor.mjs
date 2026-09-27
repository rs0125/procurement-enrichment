import { BROWSER_HEADERS } from "./session.mjs";
import { SHORT_HOSTS, resolveShortUrl, boundedText } from './http.mjs';

async function resolveViaCid(ftid, { signal } = {}) {
  const pbUrl =
    `https://www.google.com/maps/preview/place?authuser=0&hl=en&gl=in` +
    `&pb=!1m17!1s${ftid}!3m12!1m3!1d10000!2d77.5!3d13.0!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!4m2!3d13.0!4d77.5`;

  const r = await fetch(pbUrl, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: "https://www.google.com/maps",
    },
  });

  if (r.status !== 200) { await r.body?.cancel(); return null; }

  const text = await boundedText(r);
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

export async function extractCoordinatesFromUrl(url, { signal } = {}) {
  signal?.throwIfAborted();
  let finalUrl = url;
  let hostname;
  try { hostname = new URL(url).hostname; } catch {}

  if (SHORT_HOSTS.has(hostname)) {
    try {
      finalUrl = await resolveShortUrl(url, { signal });
    } catch {
      return { lat: null, lng: null, via: "error_resolve" };
    }
  }

  const urlCoords = extractCoordsFromString(finalUrl);
  if (urlCoords) return urlCoords;

  const ftidMatch = finalUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/);
  if (ftidMatch) {
    try {
      const cidCoords = await resolveViaCid(ftidMatch[1], { signal });
      if (cidCoords) return { ...cidCoords, via: "cid_lookup" };
    } catch {
      return { lat: null, lng: null, via: "error_cid" };
    }
  }

  return { lat: null, lng: null, via: "no_match" };
}

export { extractCoordsFromString, resolveViaCid };
