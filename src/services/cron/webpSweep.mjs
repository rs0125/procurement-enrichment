import { sweepImages } from './imageSweeps.mjs';

export function createWebpSweep({ repository, services, getStore, configured, invalidate = async () => {} }) {
  return {
    preview: async () => ({ status: 'DRY_RUN', configured: configured(), limit: 500,
      backlog: await repository.bounded('backlog', 'webp') }),
    async work({ signal }) {
      if (!configured()) throw new Error('Storage configuration missing');
      signal.throwIfAborted();
      const reconciliation = await repository.bounded('reconcile');
      await repository.bounded('expireClaims');
      const started = new Date();
      const existing = await getStore().existingWebpKeys(signal);
      signal.throwIfAborted();
      const rows = await repository.bounded('inventory');
      const missing = rows.filter(row => !existing.has(row.webpObjectKey) && (!row.webpCheckedAt || new Date(row.webpCheckedAt) <= started));
      let repaired = 0;
      for (let i = 0; i < missing.length; i += 100) {
        signal.throwIfAborted();
        repaired += await repository.bounded('markMissing', missing.slice(i, i + 100));
      }
      let result, projected = 0, warning;
      try { result = await sweepImages({ repository, services, stage: 'webp', service: 'webp', limit: 500, signal }); }
      finally {
        try {
          let after = 0;
          while (!signal.aborted) {
            const warehouses = await repository.bounded('warehousePage', after);
            if (!warehouses.length) break;
            projected += await repository.bounded('projectPage', warehouses);
            after = warehouses.at(-1).id;
          }
          if (signal.aborted) warning = 'Legacy projection interrupted; the next sweep repairs it';
        } catch { warning = 'Legacy projection deferred to the next sweep'; }
        try { if (result?.ready || projected) await invalidate(); }
        catch { warning = 'Cache refresh deferred to TTL'; }
      }
      return { ...result, reconciliation, repaired, projected, ...(warning ? { status: 'PARTIAL', warning } : {}) };
    }
  };
}
