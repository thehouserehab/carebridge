import { randomUUID } from 'node:crypto';

// TEST TOOLING ONLY. Never import this from the application or an HTTP route.
export const TEST_CONTROL_DATABASE = 'carebridge_integration_control';
export const TEST_DATABASE_ROLE = 'carebridge_test';
export const TEST_DATABASE_CONFIRMATION = 'create-disposable-local-database';
const runNamePattern = /^carebridge_it_[a-f0-9]{32}$/;
const unavailable = (code) => { throw new Error(code); };
const validOid = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 4294967295;

export function postgresTestOptions({ url, confirmation } = {}) {
  if (confirmation !== TEST_DATABASE_CONFIRMATION || typeof url !== 'string' ||
      !url || url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(url))
    unavailable('POSTGRES_TEST_CONFIGURATION');
  try {
    const parsed = new URL(url);
    if (!['postgres:','postgresql:'].includes(parsed.protocol) ||
        !['127.0.0.1','[::1]'].includes(parsed.hostname) ||
        !parsed.port || !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1024 || Number(parsed.port) > 65535 ||
        parsed.pathname !== `/${TEST_CONTROL_DATABASE}` || parsed.search || parsed.hash ||
        decodeURIComponent(parsed.username) !== TEST_DATABASE_ROLE || !parsed.password)
      unavailable('POSTGRES_TEST_CONFIGURATION');
    const password = decodeURIComponent(parsed.password);
    if (!password || /[\x00-\x1f\x7f]/.test(password)) unavailable('POSTGRES_TEST_CONFIGURATION');
    // Explicit fields prevent ambient PGHOST/PGDATABASE/PGOPTIONS/PGSSLMODE
    // and URL query parameters from changing the chosen target or search path.
    return Object.freeze({ host:parsed.hostname === '[::1]' ? '::1' : parsed.hostname,
      port:Number(parsed.port),database:TEST_CONTROL_DATABASE,user:TEST_DATABASE_ROLE,password,
      ssl:false,options:'-c statement_timeout=10000 -c lock_timeout=5000 -c search_path=public,pg_catalog',
      application_name:'carebridge-postgres-integration',max:4,
      connectionTimeoutMillis:4000,idleTimeoutMillis:1000,query_timeout:15000 });
  } catch {
    // Never include a URL, password, driver message, or supplied confirmation.
    unavailable('POSTGRES_TEST_CONFIGURATION');
  }
}

export function disposableDatabaseName(uuid = randomUUID()) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid))
    unavailable('POSTGRES_TEST_DATABASE_NAME');
  return `carebridge_it_${uuid.replaceAll('-','')}`;
}

export function quotedTestDatabase(name) {
  if (typeof name !== 'string' || !runNamePattern.test(name)) unavailable('POSTGRES_TEST_DATABASE_NAME');
  return `"${name}"`;
}

async function controlIdentity(admin) {
  const { rows } = await admin.query(`SELECT current_database() AS database_name,
    current_user AS role_name, session_user AS session_role,
    d.datistemplate AS is_template, d.datallowconn AS allows_connections,
    d.datdba::bigint AS owner_oid, r.oid::bigint AS role_oid,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    current_setting('server_version_num')::integer AS server_version
    FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
    WHERE d.datname = current_database()`);
  const row = rows[0];
  if (rows.length !== 1 || row.database_name !== TEST_CONTROL_DATABASE ||
      row.role_name !== TEST_DATABASE_ROLE || row.session_role !== TEST_DATABASE_ROLE ||
      row.is_template !== false || row.allows_connections !== true ||
      !validOid(row.owner_oid) || !validOid(row.role_oid) || Number(row.owner_oid) !== Number(row.role_oid) ||
      row.rolcreatedb !== true || row.rolsuper !== false || row.rolcreaterole !== false ||
      row.rolreplication !== false || row.rolbypassrls !== false ||
      !Number.isInteger(row.server_version) || row.server_version < 150000 || row.server_version >= 190000)
    unavailable('POSTGRES_TEST_CONTROL_DATABASE');
  return row;
}

export async function createDisposableDatabase(admin, name) {
  const quoted = quotedTestDatabase(name);
  const identity = await controlIdentity(admin);
  // Never IF NOT EXISTS, never adopt an existing database, never template a
  // customer's DB. CREATE/DROP DATABASE cannot run inside a transaction.
  await admin.query(`CREATE DATABASE ${quoted} TEMPLATE template0`);
  const { rows } = await admin.query(`SELECT oid::bigint AS oid, datdba::bigint AS owner_oid
    FROM pg_database WHERE datname = $1`,[name]);
  if (rows.length !== 1 || !validOid(rows[0].oid) || Number(rows[0].owner_oid) !== Number(identity.role_oid))
    unavailable('POSTGRES_TEST_OWNERSHIP');
  return Object.freeze({ name,oid:Number(rows[0].oid),ownerOid:Number(rows[0].owner_oid) });
}

export async function dropDisposableDatabase(admin, lease) {
  if (!lease || Object.keys(lease).some((key) => !['name','oid','ownerOid'].includes(key)) ||
      !Number.isSafeInteger(lease.oid) || !validOid(lease.oid) ||
      !Number.isSafeInteger(lease.ownerOid) || !validOid(lease.ownerOid))
    unavailable('POSTGRES_TEST_OWNERSHIP');
  const quoted = quotedTestDatabase(lease.name);
  const identity = await controlIdentity(admin);
  const { rows } = await admin.query(`SELECT oid::bigint AS oid, datdba::bigint AS owner_oid
    FROM pg_database WHERE datname = $1`,[lease.name]);
  if (rows.length !== 1 || Number(rows[0].oid) !== lease.oid ||
      Number(rows[0].owner_oid) !== lease.ownerOid || lease.ownerOid !== Number(identity.role_oid))
    unavailable('POSTGRES_TEST_OWNERSHIP');
  // No FORCE or pg_terminate_backend on other sessions. Active connections or
  // changed ownership must leave the disposable DB for operator inspection.
  await admin.query(`DROP DATABASE ${quoted}`);
}
