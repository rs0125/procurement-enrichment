// Opt-in local experiment; not a production consumer or a default CI test.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const connectionString = process.env.PGMQ_TEST_DATABASE_URL;
assert.ok(connectionString, 'Set a disposable local PGMQ_TEST_DATABASE_URL');
const url = new URL(connectionString);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local DB only');
assert.equal(url.port, '55441', 'Dedicated experiment port only');
assert.match(url.pathname, /^\/enricher_pgmq_(?:latest_)?test$/);
const require = createRequire(resolve(process.cwd(), 'package.json'));
const { Pool } = require('pg');
const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 3000,
  statement_timeout: 5000, application_name: 'enricher-pgmq-local-experiment' });
const queues = [];
let sequence = 0;

async function queue() {
  const name = `enrich_eval_${++sequence}`;
  await pool.query('SELECT pgmq.create($1::text)', [name]);
  queues.push(name);
  return name;
}
function table(name) {
  assert.match(name, /^enrich_eval_\d+$/);
  return `pgmq.q_${name}`;
}
async function send(name, message = { action: 'webp', subjectId: '1' }, db = pool) {
  const result = await db.query('SELECT pgmq.send($1::text, $2::jsonb) AS id', [name, message]);
  return result.rows[0].id;
}
async function read(name, seconds = 60, quantity = 1, db = pool) {
  return (await db.query('SELECT * FROM pgmq.read($1::text, $2::int, $3::int)',
    [name, seconds, quantity])).rows;
}
async function archive(name, id, db = pool) {
  return (await db.query('SELECT pgmq.archive($1::text, $2::bigint) AS archived',
    [name, id])).rows[0].archived;
}
async function expose(name, id, db = pool) {
  await db.query('SELECT * FROM pgmq.set_vt($1::text, $2::bigint, 0)', [name, id]);
}

// Prototype only: internal-table dependency must be tested before extension upgrades.
// Source locks, if needed, are acquired before the queue lock. No provider I/O here.
async function fenced(name, receipt, body, lockSource = async () => true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceValid = await lockSource(client);
    const owned = await client.query(`SELECT msg_id FROM ${table(name)}
      WHERE msg_id = $1 AND read_ct = $2 AND vt > clock_timestamp() FOR UPDATE`,
    [receipt.msg_id, receipt.read_ct]);
    if (!sourceValid || owned.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await body(client);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

before(async () => {
  const { rows } = await pool.query("SELECT extversion FROM pg_extension WHERE extname='pgmq'");
  assert.equal(rows[0]?.extversion, process.env.PGMQ_EXPECTED_VERSION);
  await pool.query(`CREATE SCHEMA enricher_pgmq_eval;
    CREATE TABLE enricher_pgmq_eval.sources (
      id bigint PRIMARY KEY, revision int NOT NULL DEFAULT 1, result_revision int,
      provider_calls int NOT NULL DEFAULT 0
    )`);
});
after(async () => {
  for (const name of queues) await pool.query('SELECT pgmq.drop_queue($1::text)', [name]);
  await pool.query('DROP SCHEMA enricher_pgmq_eval CASCADE');
  await pool.end();
});

test('committed queue tables are WAL-logged, not unlogged', async () => {
  const name = await queue();
  const { rows } = await pool.query('SELECT relpersistence FROM pg_class WHERE oid=$1::regclass', [table(name)]);
  assert.equal(rows[0].relpersistence, 'p');
});

test('source trigger commits source + event; rollback and trigger failure leave neither', async () => {
  const name = await queue();
  await pool.query(`CREATE FUNCTION enricher_pgmq_eval.capture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pgmq.send('${name}', jsonb_build_object('action','refresh-warehouse','subjectId',NEW.id::text));
      IF NEW.id = 13 THEN RAISE EXCEPTION 'fixture trigger failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture AFTER INSERT ON enricher_pgmq_eval.sources
    FOR EACH ROW EXECUTE FUNCTION enricher_pgmq_eval.capture()`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (11)');
    assert.equal((await read(name)).length, 0, 'uncommitted event not visible');
    await client.query('COMMIT');
    assert.equal((await read(name))[0].message.subjectId, '11');
    await client.query('BEGIN');
    await client.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (12)');
    await client.query('ROLLBACK');
    await assert.rejects(client.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (13)'), /fixture trigger failure/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM enricher_pgmq_eval.sources WHERE id IN (12,13)')).rows[0].n, 0);
    assert.equal((await read(name)).length, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table(name)}`)).rows[0].n, 1);
  } finally {
    client.release();
    await pool.query('DROP TRIGGER capture ON enricher_pgmq_eval.sources');
  }
});

test('eight concurrent readers claim 64 different messages with no overlap', async () => {
  const name = await queue();
  await pool.query(`SELECT pgmq.send($1::text, jsonb_build_object('subjectId', n::text)) FROM generate_series(1,64) n`, [name]);
  const deliveries = (await Promise.all(Array.from({ length: 8 }, () => read(name, 60, 8)))).flat();
  assert.equal(deliveries.length, 64);
  assert.equal(new Set(deliveries.map(row => row.msg_id)).size, 64);
  assert.equal((await read(name)).length, 0);
});

test('disconnect after receipt + actual visibility expiry redelivers the same ID', async () => {
  const name = await queue();
  const id = await send(name);
  const client = await pool.connect();
  const first = (await read(name, 1, 1, client))[0];
  client.release(true); // Drop the consumer connection without acknowledging.
  assert.equal((await read(name)).length, 0);
  await sleep(1100);
  const second = (await read(name))[0];
  assert.equal(second.msg_id, id);
  assert.equal(second.read_ct, first.read_ct + 1);
});

test('delay and retry visibility prevent early delivery', async () => {
  const name = await queue();
  const id = (await pool.query("SELECT pgmq.send($1::text, '{}'::jsonb, 60::int) AS id", [name])).rows[0].id;
  assert.equal((await read(name)).length, 0);
  await expose(name, id);
  const first = (await read(name))[0];
  assert.equal(await fenced(name, first, client => client.query(
    'SELECT * FROM pgmq.set_vt($1::text, $2::bigint, 60)', [name, id])), true);
  assert.equal((await read(name)).length, 0);
});

test('negative control: raw archive allows stale A to acknowledge B\'s redelivery', async () => {
  const name = await queue();
  await send(name);
  const first = (await read(name))[0];
  await expose(name, first.msg_id);
  const second = (await read(name))[0];
  assert.equal(second.read_ct, first.read_ct + 1);
  assert.equal(await archive(name, first.msg_id), true, 'PGMQ does not fence stale acknowledgement');
  assert.equal(await archive(name, second.msg_id), false, 'B loses the message');
});

test('receipt guard rejects stale acknowledgement and stale retry; current owner can ack', async () => {
  const name = await queue();
  await send(name);
  const first = (await read(name))[0];
  await expose(name, first.msg_id);
  const second = (await read(name))[0];
  assert.equal(await fenced(name, first, client => archive(name, first.msg_id, client)), false);
  assert.equal(await fenced(name, first, client => expose(name, first.msg_id, client)), false);
  assert.equal((await read(name)).length, 0, 'stale retry did not make current delivery visible');
  assert.equal(await fenced(name, second, client => archive(name, second.msg_id, client)), true);
});

test('expired receipt cannot publish or ack even before anyone redelivers it', async () => {
  const name = await queue();
  await send(name);
  const first = (await read(name))[0];
  await expose(name, first.msg_id);
  let called = false;
  assert.equal(await fenced(name, first, async () => { called = true; }), false);
  assert.equal(called, false);
});

test('duplicate notifications are distinct; stored domain result avoids a second provider call', async () => {
  const name = await queue();
  await pool.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (21)');
  const firstId = await send(name, { action: 'webp', subjectId: '21' });
  const secondId = await send(name, { action: 'webp', subjectId: '21' });
  assert.notEqual(firstId, secondId, 'send does not deduplicate');
  for (const receipt of await read(name, 60, 2)) {
    await fenced(name, receipt, async client => {
      await client.query(`UPDATE enricher_pgmq_eval.sources SET result_revision=revision,
        provider_calls=provider_calls+1 WHERE id=21 AND result_revision IS DISTINCT FROM revision`);
      await archive(name, receipt.msg_id, client);
    });
  }
  assert.equal((await pool.query('SELECT provider_calls FROM enricher_pgmq_eval.sources WHERE id=21')).rows[0].provider_calls, 1);
});

test('new edit retains a new notification; source guard rejects old publication', async () => {
  const name = await queue();
  await pool.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (31)');
  await send(name, { action: 'webp', subjectId: '31' });
  const old = (await read(name))[0];
  const client = await pool.connect();
  let newer;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE enricher_pgmq_eval.sources SET revision=2 WHERE id=31');
    newer = await send(name, { action: 'webp', subjectId: '31' }, client);
    await client.query('COMMIT');
  } finally { client.release(); }
  const sourceGuard = async db => (await db.query('SELECT revision FROM enricher_pgmq_eval.sources WHERE id=31 FOR UPDATE')).rows[0].revision === 1;
  assert.equal(await fenced(name, old, db => db.query('UPDATE enricher_pgmq_eval.sources SET result_revision=1 WHERE id=31'), sourceGuard), false);
  assert.equal(await fenced(name, old, db => archive(name, old.msg_id, db)), true);
  const current = (await read(name))[0];
  assert.equal(current.msg_id, newer);
  assert.equal((await pool.query('SELECT result_revision FROM enricher_pgmq_eval.sources WHERE id=31')).rows[0].result_revision, null);
});

test('saved result followed by lost ack is reused on redelivery', async () => {
  const name = await queue();
  await pool.query('INSERT INTO enricher_pgmq_eval.sources(id) VALUES (41)');
  await send(name, { action: 'webp', subjectId: '41' });
  const receipt = (await read(name))[0];
  await fenced(name, receipt, db => db.query('UPDATE enricher_pgmq_eval.sources SET result_revision=revision, provider_calls=provider_calls+1 WHERE id=41'));
  await expose(name, receipt.msg_id); // Process dies after publication, before ack.
  const recovered = (await read(name))[0];
  await fenced(name, recovered, async db => {
    await db.query('UPDATE enricher_pgmq_eval.sources SET result_revision=revision, provider_calls=provider_calls+1 WHERE id=41 AND result_revision IS DISTINCT FROM revision');
    await archive(name, recovered.msg_id, db);
  });
  assert.equal((await pool.query('SELECT provider_calls FROM enricher_pgmq_eval.sources WHERE id=41')).rows[0].provider_calls, 1);
});

test('follow-up send and parent archive are atomic on rollback and retry', async () => {
  const parent = await queue();
  const child = await queue();
  await send(parent);
  const receipt = (await read(parent))[0];
  await assert.rejects(fenced(parent, receipt, async db => {
    await send(child, { action: 'document-kind', subjectId: '1' }, db);
    await archive(parent, receipt.msg_id, db);
    throw new Error('fixture crash before commit');
  }), /fixture crash before commit/);
  assert.equal((await read(child)).length, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table(parent)}`)).rows[0].n, 1);
  assert.equal(await fenced(parent, receipt, async db => {
    await send(child, { action: 'document-kind', subjectId: '1' }, db);
    await archive(parent, receipt.msg_id, db);
  }), true);
  assert.equal((await read(child)).length, 1);
});

test('delivery count increases on unpaid deferrals, so it is not a provider attempt budget', async () => {
  const name = await queue();
  await send(name);
  for (let count = 1; count <= 6; count++) {
    const receipt = (await read(name))[0];
    assert.equal(receipt.read_ct, count);
    assert.equal(await fenced(name, receipt, db => expose(name, receipt.msg_id, db)), true);
  }
});

test('dead-letter move and acknowledgement can share one fenced transaction', async () => {
  const name = await queue();
  const dead = await queue();
  await send(name);
  const receipt = (await read(name))[0];
  assert.equal(await fenced(name, receipt, async db => {
    await send(dead, { ...receipt.message, reason: 'fixture_retry_exhausted', originalMessageId: receipt.msg_id }, db);
    await archive(name, receipt.msg_id, db);
  }), true);
  assert.equal((await read(name)).length, 0);
  assert.equal((await read(dead))[0].message.reason, 'fixture_retry_exhausted');
});

test('vanilla extension schema denies an unprivileged browser-like role', async () => {
  await pool.query('CREATE ROLE enricher_pgmq_eval_browser NOLOGIN');
  const client = await pool.connect();
  try {
    await client.query('SET ROLE enricher_pgmq_eval_browser');
    await assert.rejects(client.query('SELECT * FROM pgmq.meta'), error => error.code === '42501');
  } finally {
    await client.query('RESET ROLE');
    client.release();
    await pool.query('DROP ROLE enricher_pgmq_eval_browser');
  }
});

test('1000-message smoke run keeps application fetches bounded at one receipt', async t => {
  const name = await queue();
  const started = performance.now();
  await pool.query(`SELECT pgmq.send($1::text, jsonb_build_object('action','webp','subjectId',n::text)) FROM generate_series(1,1000) n`, [name]);
  const inserted = performance.now();
  const timings = [];
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    const [receipt] = await read(name);
    assert.ok(receipt);
    assert.equal(await fenced(name, receipt, db => archive(name, receipt.msg_id, db)), true);
    timings.push(performance.now() - start);
  }
  assert.equal((await read(name)).length, 0);
  timings.sort((a, b) => a - b);
  const sizes = await pool.query('SELECT pg_total_relation_size($1::regclass)::text AS queue_bytes, pg_total_relation_size($2::regclass)::text AS archive_bytes', [table(name), `pgmq.a_${name}`]);
  t.diagnostic(JSON.stringify({ version: process.env.PGMQ_EXPECTED_VERSION, messages: 1000,
    insertMs: Math.round(inserted-started), drainMs: Math.round(performance.now()-inserted),
    receiptAndAckP50Ms: +timings[500].toFixed(2), receiptAndAckP95Ms: +timings[950].toFixed(2),
    ...sizes.rows[0], scope: 'local SQL only; excludes providers, Supabase network, production workload' }));
});
