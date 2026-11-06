import { Client, Pool } from 'pg';

// Own driver teardown as well as pool membership. pg can remove a client
// whose password callback failed without ending its still-open connection;
// pool.end() alone also need not wait for removed clients' end callbacks.
// This adapter uses the public Client connect/end contract, not driver fields,
// private pool lists, unref, extra retries or a replacement timeout.
export function ownedPostgresPool(options) {
  if (options && Object.hasOwn(options, 'Client')) throw new TypeError('DATABASE_CLIENT_OVERRIDE_UNAVAILABLE');
  const ending = new Set();
  class OwnedClient extends Client {
    #ending;
    end(callback) {
      if (!this.#ending) {
        const completion = Promise.withResolvers();
        this.#ending = completion.promise;
        ending.add(this.#ending);
        // Retain a failed teardown so a later close cannot report success.
        this.#ending.then(() => ending.delete(this.#ending), () => {});
        try { super.end(error => error ? completion.reject(error) : completion.resolve()); }
        catch (error) { completion.reject(error); }
      }
      if (typeof callback === 'function') {
        void this.#ending.then(() => callback(), error => callback(error));
        return;
      }
      return this.#ending;
    }
    connect(callback) {
      if (typeof callback !== 'function') {
        return new Promise((resolve, reject) => this.connect(error => error ? reject(error) : resolve(this)));
      }
      let delivered = false;
      const complete = error => {
        if (delivered) return;
        delivered = true;
        if (!error) { callback(null, this); return; }
        // No credentials or commands can be retried on a failed connection.
        // Even when teardown fails, preserve the original connection error;
        // close() below independently retains and reports the teardown error.
        void this.end().then(() => callback(error), () => callback(error));
      };
      try { super.connect(complete); }
      catch (error) { if (delivered) throw error; complete(error); }
    }
  }
  const pool = new Pool({ ...options, Client: OwnedClient });
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      let poolError;
      try { await pool.end(); } catch (error) { poolError = error; }
      // Pool admission is now closed. Every removed client's end operation
      // has already been registered synchronously before pool.end settled.
      const results = await Promise.allSettled([...ending]);
      if (poolError) throw poolError;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return closing;
  };
  return Object.freeze({ pool, close });
}
