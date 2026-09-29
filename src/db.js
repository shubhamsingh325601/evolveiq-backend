import pg from 'pg';

// One pool per process. Every query is parameterised — no string-built SQL anywhere.
export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Guard against runaway queries holding a connection.
    statement_timeout: 5_000,
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}
