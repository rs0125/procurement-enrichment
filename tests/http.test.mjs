import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { enrichmentRoutes } from '../src/routes/enrichment.routes.mjs';
import { errorHandler } from '../src/middlewares/errorHandler.mjs';

test('HTTP actions require auth, dispatch one service and preserve dry-run input',async()=>{
  const calls=[],services={list:()=>[{name:'webp',input:'imageId'}],run:async(name,input)=>{calls.push({name,input});return {status:'DRY_RUN'};}};
  const app=express();app.use(express.json());app.use('/enrichment',enrichmentRoutes({services,
    authorize:(req,res,next)=>req.get('authorization')==='Bearer test-secret'?next():res.sendStatus(401)}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/enrichment/webp`;
  try {
    const unauthorized=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"imageId":1}'});
    assert.equal(unauthorized.status,401);assert.equal(calls.length,0);
    const valid=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-secret'},body:'{"imageId":1,"dryRun":true}'});
    assert.equal(valid.status,200);assert.equal((await valid.json()).status,'DRY_RUN');
    assert.equal(calls.length,1);assert.equal(calls[0].name,'webp');assert.equal(calls[0].input.dryRun,true);
    const invalid=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-secret'},body:'{"imageId":1,"signal":{}}'});
    assert.equal(invalid.status,400);assert.equal(calls.length,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('malformed and oversized request bodies fail without echoing their contents',async()=>{
  const app=express();app.use(express.json());app.post('/test',(_req,res)=>res.sendStatus(204));app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/test`;
  try {
    const bad=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"synthetic-private-value":'});
    assert.equal(bad.status,400);assert.deepEqual(await bad.json(),{error:'invalid_json'});
    const large=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:'a'.repeat(110000)})});
    assert.equal(large.status,413);assert.deepEqual(await large.json(),{error:'request_too_large'});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
