import 'dotenv/config';
import { prisma,pool,disconnect } from '../src/config/prisma.mjs';
import { createEnrichmentServices,SERVICE_INPUTS } from '../src/services/enrichment/index.mjs';

import { QueueRepository } from '../src/models/queue/repository.mjs';
import { queueSettings } from '../src/lib/queue/settings.mjs';
import { createDeliveryServices } from '../src/services/queue/deliveryServices.mjs';
const [name,...args]=process.argv.slice(2);
const services=createDeliveryServices({services:createEnrichmentServices({prisma}),queue:new QueueRepository(pool),settings:queueSettings(process.env)});
const stop=()=>services.stop();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
  if(name==='list' && !args.length) console.log(JSON.stringify(services.list(),null,2));
  else {
    if(!Object.hasOwn(SERVICE_INPUTS,name)) throw new Error('Choose a service from: '+Object.keys(SERVICE_INPUTS).join(', '));
    const field=SERVICE_INPUTS[name],flag=field==='imageId'?'--image-id=':'--warehouse-id=';
    const ids=args.filter(arg=>arg.startsWith(flag));
    if(ids.length!==1 || args.some(arg=>!arg.startsWith(flag) && arg!=='--dry-run')) throw new Error(`Usage: npm run enrich -- ${name} ${flag}123 [--dry-run]`);
    const result=await services.run(name,{[field]:Number(ids[0].slice(flag.length)),dryRun:args.includes('--dry-run')});
    console.log(JSON.stringify(result,null,2));
    if(['FAILED','UNSUPPORTED'].includes(result.status)) process.exitCode=1;
  }
} catch(error) {console.error(error.statusCode===400?'Invalid enrichment ID or options':'Enrichment command failed');process.exitCode=1;}
finally {services.stop();await disconnect();}
