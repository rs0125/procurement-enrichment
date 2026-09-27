import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import net from 'node:net';
import { once } from 'node:events';
import { createDatabasePool } from '../src/config/databasePool.mjs';

const url=process.env.ENRICHER_TEST_DATABASE_URL;
test('production database pool cancels blocked queries and remains usable',{skip:!url},async()=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));assert.equal(parsed.pathname,'/enricher_test');
  assert.equal(process.env.DATABASE_URL,url);
  const {pool,disconnect}=await import('../src/config/prisma.mjs');
  const control=new pg.Pool({connectionString:url,max:2});
  let holder,client,timer;
  try {
    holder=await control.connect(); client=await pool.connect();
    await holder.query('SELECT pg_advisory_lock(872634591)');
    const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    timer=setTimeout(()=>control.query('SELECT pg_cancel_backend($1)',[pid]).catch(()=>{}),4500);
    const started=Date.now();
    let failure;
    try {await client.query('SELECT pg_advisory_lock(872634591)');} catch(error) {failure=error;}
    assert.equal(failure?.code,'55P03','lock timeout must cancel the query before the test watchdog');
    assert.ok(Date.now()-started<4400);
    assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive,1);
    const settings=(await client.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock")).rows[0];
    assert.equal(settings.statement,'10s');assert.equal(settings.lock,'3s');
    assert.equal(pool.options.query_timeout,15000);assert.equal(pool.options.connectionTimeoutMillis,5000);
  } finally {
    clearTimeout(timer);
    if(holder) {await holder.query('SELECT pg_advisory_unlock_all()');holder.release();}
    if(client) {await client.query('SELECT pg_advisory_unlock_all()');client.release();}
    await disconnect();await control.end();
  }
});

test('a database TCP connection that never responds cannot exhaust the pool forever',{skip:!url},async()=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));assert.equal(parsed.pathname,'/enricher_test');
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.on('data',()=>{});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  parsed.port=String(server.address().port);
  const pool=createDatabasePool(parsed.href);
  const started=Date.now();
  try {
    await assert.rejects(pool.query('SELECT 1'),/timeout/i);
    assert.ok(Date.now()-started<6500);
    assert.equal(pool.totalCount,0);
  } finally {
    for(const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));await pool.end();
  }
});

test('loss of query responses times out and the pool recovers on a new connection',{skip:!url},async()=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname));assert.equal(parsed.pathname,'/enricher_test');
  let blackhole=false;
  const sockets=new Set();
  const server=net.createServer(client=>{
    const upstream=net.connect(Number(parsed.port),parsed.hostname);
    for(const socket of [client,upstream]) {sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);client.destroy();upstream.destroy();});}
    client.on('data',bytes=>{if(!blackhole) upstream.write(bytes);});
    upstream.on('data',bytes=>{if(!blackhole) client.write(bytes);});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const proxy=new URL(parsed.href);proxy.port=String(server.address().port);
  const pool=createDatabasePool(proxy.href);
  try {
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1);
    blackhole=true;const started=Date.now();
    await assert.rejects(pool.query('SELECT 2 AS value'),/timeout/i);
    assert.ok(Date.now()-started<17000);
    blackhole=false;
    assert.equal((await pool.query('SELECT 3 AS value')).rows[0].value,3);
  } finally {
    await pool.end();for(const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }
});
