import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { TEST_CONTROL_DATABASE, TEST_DATABASE_ROLE, TEST_DATABASE_CONFIRMATION } from './postgres-test-harness.mjs';

// Runs ONLY in this test's network-isolated Node worker. No external server,
// application route, production URL, account input, mail or file upload.
let pool, failed = false;
const recovery = process.argv.length === 3 && process.argv[2] === '--recovery';
const milestone = recovery ? 'Native recovery integration: 14 scenarios passed.' : 'Native PostgreSQL integration: 61 scenarios passed.';
async function ready(password) {
  const deadline = Date.now()+45000;
  while (Date.now() < deadline) {
    const candidate = new Pool({ host:'127.0.0.1',port:5432,database:'postgres',
      user:'carebridge_fixture_admin',password,ssl:false,max:1,connectionTimeoutMillis:1000,
      idleTimeoutMillis:1000,query_timeout:2000,options:'-c statement_timeout=2000 -c lock_timeout=1000' });
    candidate.on('error',() => {});
    try { await candidate.query('SELECT 1'); return candidate; }
    catch { await candidate.end(); await new Promise((resolve) => setTimeout(resolve,250)); }
  }
  throw new Error('NOT_READY');
}
async function integration(environment) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[recovery ? 'recovery-native-test.mjs' : 'postgres-integration.mjs'],{
      env:environment,stdio:['ignore','pipe','pipe'],timeout:120000,
    });
    let output = '', bytes = 0;
    child.stdout.on('data',(data) => {
      bytes += data.length;
      if (bytes > 64*1024) child.kill();
      else output += data.toString('utf8');
    });
    child.stderr.on('data',(data) => {
      bytes += data.length;
      if (bytes > 64*1024) child.kill();
      else output += data.toString('utf8');
    });
    child.on('error',() => reject(new Error('TEST_UNAVAILABLE')));
    child.on('close',(code) => resolve({ code,output }));
  });
}
try {
  const password = process.env.CAREBRIDGE_FIXTURE_PASSWORD;
  if (process.argv.length > 2 && !recovery) throw new Error('CONFIGURATION');
  if (process.platform !== 'linux' || process.version !== 'v24.15.0' || !/^[a-f0-9]{64}$/.test(password ?? ''))
    throw new Error('CONFIGURATION');
  pool = await ready(password);
  const { rows } = await pool.query("SELECT current_setting('server_version') AS version");
  if (rows[0]?.version !== '18.6') throw new Error('VERSION');
  console.log('Native server: PostgreSQL 18.6; Node v24.15.0');
  const testPassword = randomBytes(32).toString('hex');
  // Fresh synthetic role only. No supplied SQL identifier/password. SQL
  // statement logging is disabled in this private, RAM-only PG instance.
  await pool.query(`CREATE ROLE ${TEST_DATABASE_ROLE} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${testPassword}'`);
  if (recovery) {
    await pool.query('CREATE ROLE carebridge_recovery_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await pool.query(`GRANT carebridge_recovery_app TO ${TEST_DATABASE_ROLE}`);
  }
  await pool.query(`CREATE DATABASE ${TEST_CONTROL_DATABASE} OWNER ${TEST_DATABASE_ROLE} TEMPLATE template0`);
  const result = await integration({ ...process.env,CAREBRIDGE_POSTGRES_TEST_CONFIRM:TEST_DATABASE_CONFIRMATION,
    CAREBRIDGE_POSTGRES_TEST_URL:`postgresql://${TEST_DATABASE_ROLE}:${testPassword}@127.0.0.1:5432/${TEST_CONTROL_DATABASE}` });
  for (const line of result.output.split(/\r?\n/)) {
    if (/^(PASS|FAIL) [a-zA-Z0-9 ,.-]{1,160}$/.test(line) ||
        /^RECOVERY_NATIVE_[A-Z0-9_]{1,40}$/.test(line) ||
        /^POSTGRES_TEST_[A-Z_]{1,64}$/.test(line) ||
        /^Disconnect diagnostic: [A-Z0-9_]{1,40}$/.test(line) ||
        /^Disposable test target: carebridge_it_[a-f0-9]{32}$/.test(line) ||
        line === milestone) console.log(line);
  }
  if (result.code !== 0 || !result.output.includes(milestone))
    throw new Error('TEST_FAILED');
  const remaining = await pool.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname ~ '^carebridge_it_[a-f0-9]{32}$'");
  if (remaining.rows[0].count !== 0) throw new Error('CLEANUP');
  console.log('PASS temporary test database removed, no disposable database remains');
} catch {
  failed = true; console.error('POSTGRES_CONTAINER_FIXTURE_FAILED');
} finally {
  try { await pool?.end(); } catch { failed = true; }
  if (failed) process.exitCode = 1;
}
