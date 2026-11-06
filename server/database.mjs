import { ownedPostgresPool } from './postgres-pool.mjs';

// Inject a configured pool, or supply its options. This module never reads
// browser-selected roles, environment secrets, or logs connection errors.
export function postgresDatabase(options, hooks) {
  const { pool, close } = ownedPostgresPool(options);
  return { ...databaseFromPool(pool, hooks), close };
}

export function databaseFromPool(pool, { onBackgroundError = () => {}, onConnection } = {}) {
  // Background pool errors must not crash the process or leak connection data.
  // A future service can supply a content-free health signal here.
  let backgroundError = false;
  pool.on('error', () => {
    backgroundError = true;
    onBackgroundError();
  });
  return {
    // A health endpoint can report failure without serializing driver errors.
    // Clear only by reconnecting/recreating the pool after the cause is checked.
    hasBackgroundError: () => backgroundError,
    async transaction(work) {
      // Optional trusted instrumentation observes only pool acquisition. It
      // cannot replace a client, approve a connection or suppress its error.
      let finishConnection;
      if (typeof onConnection === 'function') {
        try {
          const result = onConnection();
          if (typeof result === 'function') finishConnection = result;
          else Promise.resolve(result).catch(() => {});
        } catch { /* Observation must not abandon the connection attempt. */ }
      }
      const observed = (edge) => {
        if (finishConnection) try { Promise.resolve(finishConnection(edge)).catch(() => {}); } catch { /* No observer authority. */ }
      };
      let client;
      try { client = await pool.connect(); observed('complete'); }
      catch (error) { observed('failed'); throw error; }
      let discard = false, connectionError;
      // pg-pool's idle error listener is removed while checked out. Socket
      // failure between queries would otherwise emit an unhandled error and
      // crash Node. Keep a listener until release restores pool ownership.
      const onClientError = () => {
        discard = true;
        connectionError ??= Object.assign(new Error('Database connection unavailable.'),{ code:'DATABASE_CONNECTION_LOST' });
      };
      client.on('error',onClientError);
      const query = async (sql,params) => {
        if (connectionError) throw connectionError;
        const result = await client.query(sql,params);
        if (connectionError) throw connectionError;
        return result;
      };
      try {
        await query('BEGIN');
        await query("SET LOCAL statement_timeout = '10s'");
        await query("SET LOCAL lock_timeout = '5s'");
        const value = await work({
          query,
          exec: (sql) => query(sql),
        });
        await query('COMMIT');
        return value;
      } catch (error) {
        if (!connectionError) {
          try { await client.query('ROLLBACK'); } catch { discard = true; }
        }
        // A lost connection has an unknown outcome, never automatic retry or
        // success. No raw socket error/credentials escape this event path.
        throw connectionError ?? error;
      } finally {
        try { client.release(discard); }
        finally { client.removeListener('error',onClientError); }
      }
    },
    close: () => pool.end(),
  };
}
