import { env } from "./config/env.mjs";
import { disconnect } from "./config/prisma.mjs";
import { buildApp } from "./app.mjs";
import { enrichments, cronJobs } from './routes/index.mjs';

const app = buildApp();

const server = app.listen(env.PORT, () => {
  console.log(`Warehouse Enricher running on port ${env.PORT}`);
});

async function shutdown() {
  enrichments.stop();
  cronJobs.stop();
  const deadline = setTimeout(() => process.exit(1), 30000).unref();
  await Promise.all([new Promise(resolve => server.close(resolve)), cronJobs.drain()]);
  await disconnect();
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
