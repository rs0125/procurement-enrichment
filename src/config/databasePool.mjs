import pg from 'pg';

export function createDatabasePool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5,
    connectionTimeoutMillis: 5000, query_timeout: 15000,
    idleTimeoutMillis: 30000, keepAlive: true,
    // Session-mode poolers may reject custom startup parameters. Await SET
    // before lending the connection, including to Prisma transactions.
    onConnect: client => client.query(`SELECT
      set_config('statement_timeout','10000',false),
      set_config('lock_timeout','3000',false),
      set_config('idle_in_transaction_session_timeout','15000',false)`)
  });
  pool.on('error', () => console.error('Idle database connection failed'));
  return pool;
}
