import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export async function migrate(database, directory = new URL('./migrations/', import.meta.url)) {
  const names = (await readdir(directory)).filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  return database.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(724381902)');
    await tx.exec(`CREATE TABLE IF NOT EXISTS cb_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const { rows } = await tx.query('SELECT name, checksum FROM cb_schema_migrations ORDER BY name');
    for (const applied of rows) {
      if (!migrations.some((m) => m.name === applied.name && m.checksum === applied.checksum))
        throw new Error('Migration history does not match the checked-in schema.');
    }
    const appliedNames = [];
    for (const migration of migrations) {
      if (rows.some((r) => r.name === migration.name)) continue;
      if (rows.some((r) => r.name > migration.name)) throw new Error('Out-of-order migration.');
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO cb_schema_migrations(name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      appliedNames.push(migration.name);
    }
    return appliedNames;
  });
}
