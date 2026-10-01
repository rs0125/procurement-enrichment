import 'dotenv/config';
import { createDatabasePool } from '../src/config/databasePool.mjs';
import { QueueRepository } from '../src/models/queue/repository.mjs';
import { QueueSourceRepository } from '../src/models/queue/sourceRepository.mjs';
import { createQueuePlanner } from '../src/services/queue/planner.mjs';
import { runQueueCommand } from '../src/lib/queue/cli.mjs';

let pool;
try {
  if (!process.env.DATABASE_URL) throw new Error('Database configuration missing');
  pool = createDatabasePool(process.env.DATABASE_URL);
  const result = await runQueueCommand(process.argv.slice(2), {
    queue: new QueueRepository(pool), planner: createQueuePlanner({sources: new QueueSourceRepository(pool)})
  });
  console.log(JSON.stringify(result, null, 2));
} catch {
  // Connection errors and SQL text can contain credentials or original source values.
  console.error('Queue command failed. Check arguments, database access and the queue setup runbook.');
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
