import { BROWSER_HEADERS } from './session.mjs';

export const SHORT_HOSTS = new Set(['goo.gl','maps.app.goo.gl','share.google']);
const GOOGLE_HOSTS = new Set([...SHORT_HOSTS,'google.com','www.google.com','maps.google.com',
  'google.co.in','www.google.co.in','maps.google.co.in']);

function trustedUrl(value) {
  const url = new URL(value);
  if (!GOOGLE_HOSTS.has(url.hostname) || !['http:','https:'].includes(url.protocol)
    || url.username || url.password || url.port) throw new Error('unsupported_maps_url');
  url.protocol = 'https:';
  return url.href;
}

export async function resolveShortUrl(value, { signal, http = fetch } = {}) {
  const deadline = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let current = trustedUrl(value);
  for (let hop = 0; hop < 8; hop++) {
    requestSignal.throwIfAborted();
    const response = await http(current, { signal: requestSignal, redirect: 'manual', headers: BROWSER_HEADERS });
    try {
      if (![301,302,303,307,308].includes(response.status)) return current;
      const location = response.headers.get('location');
      if (!location) throw new Error('invalid_maps_redirect');
      current = trustedUrl(new URL(location, current).href);
    } finally { await response.body?.cancel(); }
  }
  throw new Error('too_many_maps_redirects');
}

export async function boundedText(response, maxBytes = 5 * 1024 * 1024) {
  if (!response.body) return '';
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();throw new Error('maps_response_too_large');
  }
  const chunks = [];let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('maps_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
