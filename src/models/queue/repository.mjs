import { ACTIONS, LANES, QUEUE_CONTRACT_VERSION, message, receipt,
  delaySeconds, reasonCode, followups } from '../../lib/queue/contract.mjs';

// Pool is injected. Importing this module never connects or starts a worker.
export class QueueRepository {
  constructor(pool) { this.pool = pool; }

  async transaction(work, {readOnly = false, signal} = {}) {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='8s'");
      signal?.throwIfAborted();
      const result = await work(client);
      signal?.throwIfAborted();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }

  doctor() {
    return this.transaction(async client => {
      const {rows: [extension]} = await client.query(`SELECT default_version,installed_version
        FROM pg_available_extensions WHERE name='pgmq'`);
      const {rows: [state]} = await client.query(`SELECT
        has_database_privilege(current_user,current_database(),'CREATE') AS can_create_in_database,
        (SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname=current_user) AS can_manage_roles,
        EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='enrichment' AND p.proname='queue_contract_version' AND p.pronargs=0) AS contract_exists,
        EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='pgmq' AND c.relname='q_enrichment_jobs' AND c.relkind='r') AS jobs_exist,
        EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='pgmq' AND c.relname='q_enrichment_dead' AND c.relkind='r') AS dead_queue_exists,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('enrichment_capture_warehouse','enrichment_capture_coordinates')
          AND NOT tgisinternal AND tgenabled<>'D') AS source_capture_enabled`);
      let contractVersion = null, permitted = false;
      if (state.contract_exists) {
        const {rows: [grants]} = await client.query(`SELECT
          has_schema_privilege(current_user,n.oid,'USAGE') AND count(*)=13
          AND bool_and(has_function_privilege(current_user,p.oid,'EXECUTE')) AS permitted
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='enrichment' AND p.proname=ANY($1::text[]) GROUP BY n.oid`,
        [['queue_contract_version','enqueue','claim','finish','owns_receipt','defer','reject','fail_delivery','queue_stats','ensure_pending','wait_for','page_cursor','advance_page']]);
        permitted = grants?.permitted ?? false;
        if (permitted) contractVersion = (await client.query('SELECT enrichment.queue_contract_version() AS version')).rows[0].version;
      }
      return {availableVersion: extension?.default_version ?? null, installedVersion: extension?.installed_version ?? null,
        contractVersion, permitted, ...state,
        ready: extension?.installed_version === '1.5.1' && contractVersion === QUEUE_CONTRACT_VERSION
          && state.jobs_exist && state.dead_queue_exists && permitted,
        actionAdaptersAvailable: true};
    }, {readOnly: true});
  }

  async assertReady() {
    const result = await this.doctor();
    if (!result.ready) {
      const error = new Error('Queue setup is not ready'); error.code = 'queue_setup_required'; throw error;
    }
    return result;
  }

  async enqueue(input, {delay = 0, client = this.pool} = {}) {
    const validated = message(input);
    const {rows: [row]} = await client.query('SELECT enrichment.enqueue($1::jsonb,$2::integer)::text AS id',
      [JSON.stringify(validated), delaySeconds(delay)]);
    return {messageId: row.id, ...validated};
  }

  async ensurePending(input) {
    const validated=message(input);
    const {rows:[row]}=await this.pool.query('SELECT enrichment.ensure_pending($1::jsonb)::text AS id',[JSON.stringify(validated)]);
    return {messageId:row.id,...validated};
  }
  async waitFor(input,seconds,children=[]) {
    const owner=receipt(input);
    const {rows:[row]}=await this.pool.query('SELECT enrichment.wait_for($1::bigint,$2::int,$3::int,$4::jsonb) AS owned',
      [owner.msg_id,owner.read_ct,delaySeconds(seconds,1),JSON.stringify(followups(children))]);
    return row.owned;
  }
  async pruneArchive() {return (await this.pool.query('SELECT enrichment.prune_archive(1000) AS count')).rows[0].count;}

  async claim(action, lane) {
    if ((action !== null && !ACTIONS.includes(action)) || !LANES.includes(lane)) throw new Error('Invalid queue filter');
    const {rows} = await this.pool.query(`SELECT msg_id::text,read_ct,enqueued_at,vt,message
      FROM enrichment.claim($1::text,$2::text)`, [action, lane]);
    return rows[0] ?? null;
  }

  // Future action adapters call this for publication. Source locks/checks happen
  // first; both callbacks perform short SQL work on the supplied transaction only.
  withReceipt(input, {lockSource, write, signal}) {
    const owner = receipt(input);
    if (typeof lockSource !== 'function' || typeof write !== 'function') throw new Error('Source guard and publication required');
    return this.transaction(async client => {
      if (!await lockSource(client)) return {published: false, reason: 'source_changed'};
      const {rows: [row]} = await client.query('SELECT enrichment.owns_receipt($1::bigint,$2::integer) AS owned',
        [owner.msg_id, owner.read_ct]);
      if (!row.owned) return {published: false, reason: 'receipt_expired'};
      const value = await write(client);
      return {published: true, value};
    }, {signal});
  }

  async finish(input, children = []) {
    const owner = receipt(input), validated = followups(children);
    const {rows: [row]} = await this.pool.query('SELECT enrichment.finish($1::bigint,$2::integer,$3::jsonb) AS owned',
      [owner.msg_id, owner.read_ct, JSON.stringify(validated)]);
    return row.owned;
  }
  async defer(input, seconds) {
    const owner = receipt(input);
    const {rows: [row]} = await this.pool.query('SELECT enrichment.defer($1::bigint,$2::integer,$3::integer) AS owned',
      [owner.msg_id, owner.read_ct, delaySeconds(seconds, 1)]);
    return row.owned;
  }
  async reject(input, reason) {
    const owner = receipt(input);
    const {rows: [row]} = await this.pool.query('SELECT enrichment.reject($1::bigint,$2::integer,$3::text) AS owned',
      [owner.msg_id, owner.read_ct, reasonCode(reason)]);
    return row.owned;
  }
  async failDelivery(input) {
    const owner = receipt(input);
    const {rows: [row]} = await this.pool.query('SELECT enrichment.fail_delivery($1::bigint,$2::integer) AS result',
      [owner.msg_id, owner.read_ct]);
    return row.result;
  }
  async stats() {
    return this.transaction(async client => (await client.query('SELECT enrichment.queue_stats() AS stats')).rows[0].stats,
      {readOnly: true});
  }

  async recordHeartbeat(leaderPid,state) {
    const {rows:[row]}=await this.pool.query('SELECT enrichment.record_worker_heartbeat($1::int,$2::timestamptz,$3::timestamptz,$4::timestamptz,$5::boolean) AS recorded',
      [leaderPid,state.startedAt,state.lastPollAt,state.lastCompletedAt,state.healthy]);
    return row.recorded;
  }
  async alerts() {
    return this.transaction(async client=>(await client.query('SELECT * FROM enrichment.alert_status ORDER BY code')).rows,{readOnly:true});
  }
}
