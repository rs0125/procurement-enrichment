export function healthController(prisma) {
  return async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'connected' });
    } catch {
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  };
}
