const { setTimeout: delay } = require('node:timers/promises');

// Retrying publication reuses the assessment already paid for. The token/lease
// predicate also makes an ambiguously acknowledged write safe to repeat.
function isTransientDatabaseError(error) {
    return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code)
        || (error.code === 'P2010' && ['40001', '40P01', '55P03', '57014'].includes(error.meta?.code));
}
async function retryDatabase(operation, { signal } = {}) {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            if (attempt >= 2 || signal?.aborted || !isTransientDatabaseError(error)) throw error;
            try { await delay(500 * 2 ** attempt, null, { signal }); }
            catch { throw error; }
        }
    }
}
module.exports = { isTransientDatabaseError, retryDatabase };
