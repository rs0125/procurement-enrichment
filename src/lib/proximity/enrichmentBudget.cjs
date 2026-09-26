const { setTimeout: delay } = require('node:timers/promises');

/** A deadline cancels requests and waits; it never leaves detached paid work running. */
function createBudget(durationMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), durationMs);
    timer.unref?.();
    return { signal: controller.signal, close: () => clearTimeout(timer) };
}

const sleep = (ms, signal) => delay(ms, undefined, { signal });
const expired = (signal) => Boolean(signal?.aborted);
const check = (signal) => {
    if (expired(signal)) {
        const error = new Error('Enrichment time budget exhausted');
        error.name = 'AbortError';
        throw error;
    }
};

module.exports = { createBudget, sleep, expired, check };
