import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShortUrl, boundedText } from '../src/lib/googleMaps/http.mjs';
import { extractCoordinatesFromUrl } from '../src/lib/googleMaps/extractor.mjs';

test('normal Maps short links still resolve and release response bodies', async () => {
  const calls = [];let cancelled = 0;
  const final = 'https://www.google.com/maps?q=12.34,77.56';
  const result = await resolveShortUrl('http://maps.app.goo.gl/example', { http: async (url, options) => {
    calls.push(url);assert.equal(options.redirect, 'manual');
    return { status: calls.length === 1 ? 302 : 200, headers: new Headers({ location: final }),
      body: { cancel: async () => { cancelled++; } } };
  } });
  assert.equal(result, final);assert.equal(calls[0], 'https://maps.app.goo.gl/example');assert.equal(cancelled, 2);
  assert.deepEqual(await extractCoordinatesFromUrl(final), { lat: 12.34, lng: 77.56, via: 'url_q=' });
});

test('Maps redirects to local addresses, unrelated hosts or URLs with credentials are rejected before a request', async () => {
  for (const location of ['http://169.254.169.254/latest/meta-data/','https://google.com.attacker.invalid/',
    'https://user:secret@www.google.com/maps','https://www.google.com:8443/maps']) {
    let calls = 0,cancelled = 0;
    await assert.rejects(resolveShortUrl('https://share.google/example', { http: async () => {
      calls++;return { status: 302, headers: new Headers({ location }), body: { cancel: async () => { cancelled++; } } };
    } }), /unsupported_maps_url/);
    assert.equal(calls, 1);assert.equal(cancelled, 1);
  }
});

test('redirect loops and oversized Maps responses are bounded', async () => {
  let calls = 0;
  await assert.rejects(resolveShortUrl('https://goo.gl/example', { http: async () => {
    calls++;return new Response(null, { status: 302, headers: { location: '/loop' } });
  } }), /too_many_maps_redirects/);
  assert.equal(calls, 8);
  await assert.rejects(boundedText(new Response('123456'), 5), /maps_response_too_large/);
});
