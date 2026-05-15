import { env } from "./config/env.mjs";
import { disconnect } from "./config/prisma.mjs";
import { buildApp } from "./app.mjs";

const app = buildApp();

const server = app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT}`);
});

async function shutdown() {
  server.close();
  await disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
