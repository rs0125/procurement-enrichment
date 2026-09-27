import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { createDatabasePool } from '../../src/config/databasePool.mjs';

const target=new URL(process.env.ENRICHER_TEST_DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));assert.equal(target.pathname,'/enricher_test');
let drop=false,connections=0;
const sockets=new Set(),control=new pg.Pool({connectionString:target.href,max:1});
const server=net.createServer(client=>{
  connections++;
  const upstream=net.connect(Number(target.port),target.hostname);
  for(const socket of [client,upstream]) {
    sockets.add(socket);socket.on('error',()=>{});
    socket.on('close',()=>{sockets.delete(socket);client.destroy();upstream.destroy();});
  }
  client.on('data',bytes=>upstream.write(bytes));
  upstream.on('data',bytes=>{if(!drop)client.write(bytes);});
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const proxy=new URL(target.href);proxy.port=String(server.address().port);
const pool=createDatabasePool(proxy.href),prisma=new PrismaClient({adapter:new PrismaPg(pool)});
try {
  await control.query('CREATE TABLE IF NOT EXISTS _enricher_transaction_fault (value int PRIMARY KEY)');
  await control.query('TRUNCATE _enricher_transaction_fault');
  const started=Date.now();
  await assert.rejects(prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('INSERT INTO _enricher_transaction_fault VALUES (1)');
    drop=true;
    await tx.$queryRawUnsafe('SELECT 2');
  },{maxWait:3000,timeout:8000}));
  assert.ok(Date.now()-started<25000);
  drop=false;
  // A late rollback rejection must kill this child under --unhandled-rejections=strict.
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await control.query('SELECT count(*)::int AS n FROM _enricher_transaction_fault')).rows[0].n,0);
  await prisma.$transaction(tx=>tx.$executeRawUnsafe('INSERT INTO _enricher_transaction_fault VALUES (2)'));
  assert.equal((await control.query('SELECT value FROM _enricher_transaction_fault')).rows[0].value,2);
  assert.ok(connections>=2);
  console.log('transaction failed safely; rollback and next transaction verified');
} finally {
  for(const socket of sockets)socket.destroy();
  await prisma.$disconnect();await pool.end();await control.end();
  await new Promise(resolve=>server.close(resolve));
}
