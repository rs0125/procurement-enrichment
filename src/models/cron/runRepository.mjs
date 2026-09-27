export class CronRunRepository {
  constructor(prisma) { this.prisma = prisma; }

  bounded(work) {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      return work(tx);
    }, { maxWait: 3000, timeout: 8000 });
  }

  tryStart(jobName, staleAfterMs, metadata = null) {
    return this.bounded(async tx => {
      const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${jobName})::bigint) AS acquired`;
      if (!lock.acquired) return null;
      const cutoff = new Date(Date.now() - staleAfterMs);
      if (await tx.cronRunLog.findFirst({ where: { jobName, status: 'RUNNING', ranAt: { gte: cutoff } } })) return null;
      await tx.cronRunLog.updateMany({ where: { jobName, status: 'RUNNING', ranAt: { lt: cutoff } },
        data: { status: 'INTERRUPTED', notes: 'Previous worker did not finish within its run budget' } });
      return tx.cronRunLog.create({ data: { jobName, status: 'RUNNING', durationMs: 0, metadata } });
    });
  }

  finish(id, status, durationMs, metadata = null) {
    return this.bounded(tx => tx.cronRunLog.update({ where: { id }, data: { status, durationMs, metadata } }));
  }

  recent(jobName) {
    return this.bounded(tx => tx.cronRunLog.findFirst({ where: { jobName }, orderBy: [{ ranAt: 'desc' }, { id: 'desc' }] }));
  }
}
