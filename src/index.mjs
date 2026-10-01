import { env } from './config/env.mjs';
import { disconnect } from './config/prisma.mjs';
import { buildApp } from './app.mjs';
import { enrichments,cronJobs,queueRuntime,onMemoryLimit } from './routes/index.mjs';
let server,stopping;
async function shutdown(code=0) {
  if(stopping) return stopping;
  stopping=(async()=>{
    enrichments.stop();cronJobs.stop();queueRuntime.stop();
    const deadline=setTimeout(()=>process.exit(1),30000).unref();
    const results=await Promise.allSettled([new Promise(resolve=>server?server.close(resolve):resolve()),cronJobs.drain(),queueRuntime.drain()]);
    try {await disconnect();} catch {code=1;}
    clearTimeout(deadline);
    process.exit(results.some(r=>r.status==='rejected')?1:code);
  })();
  return stopping;
}
queueRuntime.onFailure(()=>{console.error('Queue worker lost ownership');void shutdown(1);});
onMemoryLimit(()=>{console.error('Worker memory limit reached; draining for supervised restart');void shutdown(1);});
process.on('SIGTERM',()=>void shutdown());
process.on('SIGINT',()=>void shutdown());
try {
  await queueRuntime.start();
  if(!stopping) server=buildApp().listen(env.PORT,()=>console.log(`Warehouse Enricher running on port ${env.PORT}`));
} catch {console.error('Enrichment startup failed');await shutdown(1);}
