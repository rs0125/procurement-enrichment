/**
 * Shared prompt, schema and API call for warehouse image classification.
 *
 * Both the sample harness (classifyWarehouseImagesSample.js) and the backfill
 * (backfillWarehouseImageLabels.js) import from here. Keeping one copy is the
 * point: the model was chosen on the strength of sample results, so the backfill
 * must run the identical prompt or those results describe nothing.
 */
const LABELS = ['INDOOR', 'OUTDOOR', 'DOCUMENT', 'UNKNOWN'];

/**
 * An earlier revision carried the rule "standing under a canopy or inside an
 * open-sided shed counts as INDOOR". It was removed after an ablation on the
 * contested images: it contradicts the camera-position rule, and Indian
 * warehouse listings are full of dock aprons shot from the yard under a canopy,
 * so it misfired constantly. Dropping it took gpt-5.6-terra from 3/4 to 4/4 and
 * gpt-5-nano from 1/4 to 4/4, and made no model worse. Do not reinstate it
 * without re-running that comparison.
 */
const PROMPT = `You are labelling photographs attached to Indian industrial warehouse listings.

Classify this image into exactly one category:

- INDOOR: the camera is inside the warehouse/shed/building envelope. Interior floor, roof trusses, sheeting, columns, racking, internal offices, washrooms, staircases, interior of a dock from inside.
- OUTDOOR: the camera is outside the building envelope. Building facades and elevations, dock aprons and yards seen from outside, approach roads, gates and boundary walls, land parcels, open ground, surrounding area, aerial or drone shots.
- DOCUMENT: the image is primarily a document, drawing or screen rather than a scene. Floor plans, site layouts, CAD drawings, khata/EC/tax paperwork, rent agreements, compliance certificates, spreadsheets, screenshots, maps, photos of printed or handwritten pages.
- UNKNOWN: genuinely unclassifiable, corrupt, blank, or so dark/blurred that the category cannot be determined.

Rules:
- Judge by where the CAMERA is, not by what the building is. A shed photographed from the yard is OUTDOOR, even if it has a canopy or an open side.
- If the camera stands in a doorway or opening, classify by what fills the frame, not by where the photographer's feet are.
- If a document is photographed lying on a desk, it is still DOCUMENT.
- Prefer INDOOR/OUTDOOR/DOCUMENT over UNKNOWN; use UNKNOWN only as a genuine last resort.

Also write a short factual description of what is visible, at most 25 words. Describe only what you can actually see. Do not speculate about the property's quality, size or value.

confidence is your own certainty in the label, from 0 to 1.`;

/**
 * Sub-labels for an image already classified DOCUMENT.
 *
 * DOCUMENT is one bucket holding two unrelated things: drawings that belong on a
 * client deck, and paperwork that must never reach one. v3 renders a layout on a
 * slide of its own, so the deck needs to know which is which, and "it is a
 * document" does not answer that.
 *
 * NOT_A_DOCUMENT exists because the response schema is strict — every property is
 * required, so there is no way to omit this field for a photograph. Making the
 * "inapplicable" case explicit beats inventing a nullable the API cannot express.
 */
const DOC_KINDS = ['LAYOUT', 'PAPERWORK', 'OTHER_DOCUMENT', 'NOT_A_DOCUMENT'];

const DOC_PROMPT = `You are sorting images attached to Indian industrial warehouse listings. This image has already been identified as a document, drawing or screen rather than a photograph of a place.

Decide which kind of document it is:

- LAYOUT: an architectural or engineering drawing of the property. Floor plans, site plans, site layouts, CAD drawings, elevations, sections, plot/survey plans, block plans, dimensioned sketches of the shed or land. A drawing of the SPACE, whether CAD-drawn or hand-drawn.
- PAPERWORK: a text document. Khata extracts, encumbrance certificates, tax receipts, rent or lease agreements, NOCs, compliance and occupancy certificates, letters, invoices, identity or ownership papers, any photographed page that is mostly prose or a form.
- OTHER_DOCUMENT: a document or screen that is neither of the above. Map screenshots, satellite views, spreadsheets, price tables, brochures, WhatsApp or app screenshots, photographs of a computer monitor.
- NOT_A_DOCUMENT: on looking again this is an ordinary photograph of a place, not a document at all.

Rules:
- Judge by WHAT THE DRAWING SHOWS, not by how neat it is. A hand-drawn dimensioned sketch of a shed is LAYOUT; a beautifully typeset lease is PAPERWORK.
- A map or satellite screenshot is OTHER_DOCUMENT, not LAYOUT: it shows where the property is, not how it is built.
- A title block, dimension strings, a scale bar or a north arrow are strong evidence of LAYOUT.
- A page that is mostly running text or stamped/signed is PAPERWORK even if it mentions dimensions.
- Use NOT_A_DOCUMENT only if this plainly is not a document; the earlier pass said it was.

confidence is your own certainty in this sub-label, from 0 to 1.`;

const DOC_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        documentKind: { type: 'string', enum: DOC_KINDS },
        // Why it landed there, so a wrong call can be argued with rather than
        // just re-run. Short: this is a filing decision, not a description.
        reason: { type: 'string' },
        confidence: { type: 'number' },
    },
    required: ['documentKind', 'reason', 'confidence'],
};

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        classification: { type: 'string', enum: LABELS },
        description: { type: 'string' },
        confidence: { type: 'number' },
    },
    required: ['classification', 'description', 'confidence'],
};

/** USD per 1M tokens, standard (non-batch) tier. Batch is half. */
const PRICING = {
    'gpt-5.6-sol': { in: 5.0, out: 30.0 },
    'gpt-5.6-terra': { in: 2.0, out: 12.0 },
    'gpt-5.6-luna': { in: 0.2, out: 1.2 },
    'gpt-5-mini': { in: 0.25, out: 2.0 },
    'gpt-5-nano': { in: 0.05, out: 0.4 },
    'gpt-4.1-mini': { in: 0.4, out: 1.6 },
    'gpt-4.1-nano': { in: 0.1, out: 0.4 },
    'gpt-4o-mini': { in: 0.15, out: 0.6 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classifies one image. Returns {classification, description, confidence,
 * inputTokens, outputTokens, latencyMs} or {error}. Never throws — a bad image
 * should cost one row, not the run.
 *
 * Only the URL is sent; OpenAI fetches the bytes from R2 itself.
 */
async function callModel(model, imageUrl, prompt, schema, {
    detail = 'low', maxAttempts = 5, schemaName = 'image_label', signal,
} = {}) {
    const budget = require('./enrichmentBudget.cjs');
    const pause = (ms) => signal ? budget.sleep(ms, signal) : sleep(ms);
    const body = {
        model,
        input: [{
            role: 'user',
            content: [
                { type: 'input_text', text: prompt },
                { type: 'input_image', image_url: imageUrl, detail },
            ],
        }],
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    };

    for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) return { error: 'Enrichment time budget exhausted' };
        const started = Date.now();
        let res;
        try {
            res = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal,
            });
        } catch (err) {
            if (signal?.aborted) return { error: 'Enrichment time budget exhausted' };
            if (attempt < maxAttempts - 1) {
                try { await pause(2 ** attempt * 1000); } catch { return { error: 'Enrichment time budget exhausted' }; }
                continue;
            }
            return { error: `network: ${err.message}` };
        }

        if (!res.ok) {
            const text = await res.text();
            if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
                try { await pause(2 ** attempt * 1000 + Math.floor(Math.random() * 500)); }
                catch { return { error: 'Enrichment time budget exhausted' }; }
                continue;
            }
            return { error: `http ${res.status}: ${text.slice(0, 300)}` };
        }

        const json = await res.json();
        let raw = json.output_text;
        if (!raw) {
            raw = (json.output || [])
                .flatMap((o) => o.content || [])
                .filter((c) => c.type === 'output_text')
                .map((c) => c.text)
                .join('');
        }
        if (!raw) return { error: `no text in response: ${JSON.stringify(json).slice(0, 300)}` };

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { error: `unparseable json: ${raw.slice(0, 200)}` };
        }

        const usage = json.usage || {};
        return {
            ...parsed,
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            latencyMs: Date.now() - started,
        };
    }
}

/**
 * Scene type for one image. Unchanged in behaviour — the prompt above carries an
 * ablation history and the model was chosen on its results, so it must keep
 * running exactly as it did.
 */
function classify(model, imageUrl, opts = {}) {
    return callModel(model, imageUrl, PROMPT, SCHEMA, { ...opts, schemaName: 'image_label' });
}

/**
 * Which kind of document an already-DOCUMENT image is.
 *
 * A separate call rather than extra fields on the scene prompt: that prompt is
 * tuned and measured, and only 223 of ~14,000 labelled images are documents, so
 * asking every photograph about title blocks would cost 60x more to answer a
 * question that does not apply to it.
 */
function classifyDocumentKind(model, imageUrl, opts = {}) {
    return callModel(model, imageUrl, DOC_PROMPT, DOC_SCHEMA, { ...opts, schemaName: 'document_kind' });
}

module.exports = {
    LABELS, PROMPT, SCHEMA, PRICING, classify, sleep,
    DOC_KINDS, DOC_PROMPT, DOC_SCHEMA, classifyDocumentKind, callModel,
};
