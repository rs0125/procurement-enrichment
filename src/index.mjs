import { env } from "./config/env.mjs";
import { disconnect } from "./config/prisma.mjs";
import { buildApp } from "./app.mjs";
import { enrichments } from './routes/index.mjs';

const app = buildApp();

const server = app.listen(env.PORT, () => {
  console.log(`Warehouse Enricher running on port ${env.PORT}`);
});

async function shutdown() {
  enrichments.stop();
  const deadline = setTimeout(() => process.exit(1), 30000).unref();
  await new Promise(resolve => server.close(resolve));
  await disconnect();
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
