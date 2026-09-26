const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { callModel } = require('./imageClassifier.cjs');
const { MODEL, VERSION, TIERS, PROMPT, SCHEMA } = require('./websiteImagePolicy.cjs');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40000000;
const PROMPT_SHA256 = createHash('sha256').update(PROMPT).digest('hex');
const COVER_VIEWS = new Set(['INTERIOR_OVERVIEW','EXTERIOR_FACADE','LOADING_DOCK','YARD','LAND']);

class AssessmentError extends Error {
    constructor(code, unsupported = false) { super(code); this.code = code; this.unsupported = unsupported; }
}
function validateSource(value) {
    let url;
    try { url = new URL(value); } catch { throw new AssessmentError('invalid_source_url', true); }
    let configuredHost;
    try { configuredHost = new URL(process.env.R2_PUBLIC_URL).hostname; } catch {}
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || (!/^pub-[a-f0-9]{32}\.r2\.dev$/.test(url.hostname) && url.hostname !== configuredHost)) {
        throw new AssessmentError('unsupported_source_host', true);
    }
    return url.href;
}
async function downloadOriginal(value, signal, http = fetch) {
    const url = validateSource(value);
    const response = await http(url, { signal, redirect: 'error' });
    if (!response.ok) throw new AssessmentError(`source_http_${response.status}`, [404,410].includes(response.status));
    if (!response.body) throw new AssessmentError('empty_source');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body.cancel(); throw new AssessmentError('source_over_20MiB', true);
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new AssessmentError('source_over_20MiB', true);
        chunks.push(chunk);
    }
    if (!bytes) throw new AssessmentError('empty_source');
    return { buffer: Buffer.concat(chunks), etag: response.headers.get('etag') || null };
}
function cleanText(value) {
    return value.slice(0, 400).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[contact redacted]')
        .replace(/\+?\d(?:[\s().-]*\d){6,}/g, '[contact redacted]');
}
function validateAssessment(raw) {
    if (!raw || typeof raw !== 'object' || SCHEMA.required.some(key => !Object.hasOwn(raw, key))) throw new AssessmentError('invalid_model_result');
    for (const key of ['decision','scene','qualityTier','view']) {
        if (!SCHEMA.properties[key].enum.includes(raw[key])) throw new AssessmentError('invalid_model_result');
    }
    for (const key of ['reasons','qualityIssues']) {
        if (!Array.isArray(raw[key]) || raw[key].some(value => !SCHEMA.properties[key].items.enum.includes(value))) throw new AssessmentError('invalid_model_result');
    }
    if (typeof raw.coverSuitable !== 'boolean' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1
        || typeof raw.decisionReason !== 'string' || typeof raw.qualityReason !== 'string' || !Array.isArray(raw.evidence)) throw new AssessmentError('invalid_model_result');
    if (raw.evidence.length > 30 || raw.evidence.some(e => !e || typeof e.note !== 'string'
        || ['x1','y1','x2','y2'].some(k => !Number.isFinite(e[k]) || e[k] < 0 || e[k] > 1000)
        || e.x1 >= e.x2 || e.y1 >= e.y2)) throw new AssessmentError('invalid_model_evidence');
    return Object.fromEntries(SCHEMA.required.map(key => [key, raw[key]]));
}
function normalizeAssessment(raw, source) {
    const modelResult = validateAssessment(raw);
    if (!/^[a-f0-9]{64}$/.test(source.sha256 || '') || !(source.width > 0 && source.height > 0)) throw new AssessmentError('invalid_source_metadata');
    let decision = modelResult.decision, qualityTier = modelResult.qualityTier;
    const guards = [];
    const cap = (tier, reason) => {
        if (TIERS.indexOf(qualityTier) < TIERS.indexOf(tier)) { qualityTier = tier; guards.push(reason); }
    };
    const longest = Math.max(source.width, source.height);
    if (longest < 640) cap('T3', 'small_source');
    else if (longest < 960) cap('T2', 'limited_resolution');
    // Benchmark failures were dim details / blurred obstructed frames, not merely old buildings.
    const issues = new Set(modelResult.qualityIssues);
    if ((issues.has('DARK') && ['DETAIL','WASHROOM','STAIRS'].includes(modelResult.view))
        || (issues.has('BLUR') && (issues.has('DARK') || issues.has('OBSTRUCTION')))) cap('T3', 'weak_detail_or_obstructed_blur');
    if (decision === 'ALLOW' && (modelResult.reasons.length || !['INDOOR','OUTDOOR'].includes(modelResult.scene))) {
        decision = modelResult.scene === 'DOCUMENT' || modelResult.reasons.includes('DOCUMENT') ? 'BLOCK' : 'REVIEW';
        guards.push('inconsistent_allow');
    }
    const coverSuitable = decision === 'ALLOW' && ['T1','T2'].includes(qualityTier)
        && modelResult.coverSuitable && COVER_VIEWS.has(modelResult.view) && Math.min(source.width, source.height * 16 / 9) >= 640;
    return { decision, qualityTier, assessment: {
        ...modelResult, decision, qualityTier, coverSuitable,
        decisionReason: cleanText(modelResult.decisionReason), qualityReason: cleanText(modelResult.qualityReason),
        evidence: modelResult.evidence.map(e => ({ ...e, note: cleanText(e.note) })),
        modelDecision: modelResult.decision, modelQualityTier: modelResult.qualityTier,
        modelCoverSuitable: modelResult.coverSuitable, guards,
        model: MODEL, version: VERSION, promptSha256: PROMPT_SHA256, qualityPolicy: 'website-quality-guards-v1',
        sourceSha256: source.sha256, sourceWidth: source.width, sourceHeight: source.height,
        sourceBytes: source.bytes, sourceFormat: source.format, sourceEtag: source.etag || null,
    } };
}
async function assessWebsiteImage(imageUrl, { signal, http = fetch, modelCall = callModel, preferUrl = false } = {}) {
    const deadline = AbortSignal.timeout(110000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const downloadSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(30000)]);
    let downloaded;
    try { downloaded = await downloadOriginal(imageUrl, downloadSignal, http); }
    catch (error) {
        if (error instanceof AssessmentError) throw error;
        throw new AssessmentError(downloadSignal.aborted ? 'source_timeout' : 'source_download_failed');
    }
    const { buffer, etag } = downloaded;
    let metadata;
    try { metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata(); }
    catch { throw new AssessmentError('unsupported_or_corrupt_image', true); }
    if (!['jpeg','png','webp','gif'].includes(metadata.format) || (metadata.pages || 1) > 1
        || !(metadata.width > 0 && metadata.height > 0) || metadata.width * metadata.height > MAX_PIXELS) {
        throw new AssessmentError('unsupported_image_format_or_dimensions', true);
    }
    const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
    const source = { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length,
        width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height,
        format: metadata.format, etag };
    const mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`;
    let inputTransport = preferUrl ? 'original-url' : 'original-bytes';
    const request = input => modelCall(MODEL, input, PROMPT, SCHEMA,
        { detail: 'high', maxAttempts: 2, schemaName: 'website_image_eval', signal: requestSignal });
    let response;
    try {
        response = await request(preferUrl ? validateSource(imageUrl) : `data:${mime};base64,${buffer.toString('base64')}`);
        // The backfill uses immutable original R2 URLs to avoid a second large
        // transfer over the local uplink. Provider-side fetch failures use the
        // exact original bytes we already downloaded, checked and hashed.
        if (preferUrl && !requestSignal.aborted && /^http (400|422):/.test(response.error || '')
            && /image|download/i.test(response.error)) {
            inputTransport = 'original-bytes';
            response = await request(`data:${mime};base64,${buffer.toString('base64')}`);
        }
    } catch {
        throw new AssessmentError(requestSignal.aborted ? 'model_timeout' : 'model_response_failed');
    }
    if (response.error) {
        const status = /^http (\d+)/.exec(response.error)?.[1];
        throw new AssessmentError(status ? `model_http_${status}` : requestSignal.aborted ? 'model_timeout' : 'model_request_failed');
    }
    const result = normalizeAssessment(response, source);
    result.assessment.inputTransport = inputTransport;
    return { ...result, usage: { inputTokens: response.inputTokens || 0,
        outputTokens: response.outputTokens || 0, latencyMs: response.latencyMs || 0 } };
}
module.exports = { MODEL, VERSION, MAX_BYTES, MAX_PIXELS, AssessmentError, validateSource,
    downloadOriginal, validateAssessment, normalizeAssessment, assessWebsiteImage };
