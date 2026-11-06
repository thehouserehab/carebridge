// Shared lifetime mechanics for a freshly owned synthetic Windows/E cluster.
// Construction does no IO. The caller still verifies the portable runtime,
// creates a new UUID root/receipt and owns signals, TLS and database services.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {lstat,open,readFile,realpath,unlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname,join,resolve,win32} from 'node:path';
import {Pool} from 'pg';
import {windowsPostgresOptions,postgresCheckPaths,windowsPostgresEnvironment} from './windows-postgres-policy.mjs';
const configurationError = () => new Error('WINDOWS_POSTGRES_CONFIGURATION');
const retainedError = () => new Error('WINDOWS_POSTGRES_RETAINED_UNAVAILABLE');
const systemIdentifierValid = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
function dataRecord(value,allowed) {
  if (!record(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw configurationError();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value,key);
    if (typeof key !== 'string' || allowed && !allowed.includes(key) || !Object.hasOwn(property,'value')) throw configurationError();
    result[key] = property.value;
  }
  return result;
}

export async function freshFile(path,bytes) {
  const handle = await open(path,'wx',0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function regularDirectoryChain(path) {
  for (let part = resolve(path);; part = dirname(part)) {
    const info = await lstat(part); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(resolve(await realpath(part)).toLowerCase(),part.toLowerCase());
    if (dirname(part) === part) break;
  }
}

export function createSyntheticPostgresRuntime(input) {
  let options,root,environment,roles;
  try {
    const value = dataRecord(input,['options','root','environment','roles']);
    const proposed = dataRecord(value.options,['base','powershell','privateRoot','bin']);
    options = windowsPostgresOptions(['--base',proposed.base,'--powershell',proposed.powershell,'--confirm-synthetic-e-drive']);
    assert.deepEqual(proposed,{...options});
    root = value.root;
    const runId = typeof root === 'string' && win32.basename(root).replace(/^postgres-check-/,'');
    assert.equal(root,postgresCheckPaths(options.privateRoot,runId).root);
    const proposedEnvironment = dataRecord(value.environment);
    environment = windowsPostgresEnvironment(proposedEnvironment,options.bin);
    assert.deepEqual(proposedEnvironment,environment); Object.freeze(environment);
    const proposedRoles = value.roles === undefined ? [] : value.roles;
    if (!Array.isArray(proposedRoles) || Reflect.ownKeys(proposedRoles).length !== proposedRoles.length+1) throw configurationError();
    roles = Array.from({length:proposedRoles.length},(_,index) => {
      const property = Object.getOwnPropertyDescriptor(proposedRoles,String(index));
      if (!property || !Object.hasOwn(property,'value') || typeof property.value !== 'string' ||
          !/^carebridge_fixture_[a-z]+$/.test(property.value) || ['carebridge_fixture_owner','carebridge_fixture_admin'].includes(property.value)) throw configurationError();
      return property.value;
    });
    if (new Set(roles).size !== roles.length) throw configurationError(); Object.freeze(roles);
  } catch { throw configurationError(); }
  const clusters = [],owned = new WeakSet(),pendingSecretFiles = new Set();
  const retained = new WeakMap(),registrations = new Set(),inspections = new WeakSet();

  async function disposeInitPassword(pending) {
    let removalError;
    // A failed exclusive open does not confer ownership of an existing file.
    if (pending.created) try { await unlink(pending.path); } catch (error) { removalError = error; }
    try { await lstat(pending.path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw removalError ?? error;
      pendingSecretFiles.delete(pending);
      if (removalError && removalError.code !== 'ENOENT') throw removalError;
      return;
    }
    throw removalError ?? new Error('WINDOWS_POSTGRES_SECRET_PENDING');
  }

  function native(command,args,{cwd,env = environment,timeout = 45000,input,rejectStderr = false} = {}) {
    return new Promise((yes,no) => {
      let size = 0,output = '',diagnostic = '',aborted = false,failed = false,stderrSeen = false;
      let timedOut = false,outputExceeded = false,spawnFailed = false;
      const failure = (code) => {
        const error = new Error('WINDOWS_POSTGRES_PROCESS'); error.exitCode = code;
        error.category = /invalid locale|locale name.*not recognized/i.test(diagnostic) ? 'LOCALE' :
          /unrecognized configuration parameter|invalid value for parameter/i.test(diagnostic) ? 'SETTING' :
          /Permission denied|Access is denied/i.test(diagnostic) ? 'PERMISSION' : 'NATIVE_COMMAND';
        // Fixed observations only: never retain raw process errors, arguments,
        // stdout/stderr or a cause containing paths and private input.
        Object.assign(error,{timedOut,outputExceeded,spawnFailed});
        return error;
      };
      let child;
      try { child = spawn(command,args,{cwd,env,shell:false,windowsHide:true,stdio:[input ? 'pipe' : 'ignore','pipe','pipe']}); }
      catch { spawnFailed = true; no(failure(null)); return; }
      const requestStop = () => {
        aborted = true;
        try { child.kill(); } catch { failed = true; }
      };
      const timer = setTimeout(() => { timedOut = true; requestStop(); },timeout);
      const stop = () => { if (size > 4*1024*1024) { outputExceeded = true; requestStop(); } };
      child.stdout.on('data',(data) => {
        size += data.length;
        // A failed child can keep writing while termination is observed. Do
        // not retain output beyond the same existing combined byte ceiling.
        if (size <= 4*1024*1024) output += data.toString('utf8');
        stop();
      });
      child.stderr.on('data',(data) => { size += data.length; stderrSeen ||= data.length > 0; if (diagnostic.length < 8192) diagnostic += data.toString('utf8').slice(0,8192-diagnostic.length); stop(); });
      // Error/kill acknowledgement is not process termination. Keep ownership
      // through the actual close event, including failed spawn and late IO.
      child.on('error',() => { failed = true; if (child.pid === undefined) spawnFailed = true; });
      child.once('close',(code) => {
        clearTimeout(timer);
        if (code === 0 && !aborted && !failed && !(rejectStderr && stderrSeen)) yes(output.trim());
        else no(failure(code));
      });
      if (input) { child.stdin.on('error',() => {}); child.stdin.end(input); }
    });
  }

  async function freeLoopbackPort() {
    const server = createServer();
    await new Promise((yes,no) => { server.once('error',no); server.listen(0,'127.0.0.1',yes); });
    const port = server.address().port;
    await new Promise((yes,no) => server.close((error) => error ? no(error) : yes()));
    if (clusters.some((cluster) => cluster.port === port)) return freeLoopbackPort();
    return port; // Address race remains fail-closed by data_directory and PID checks.
  }

  function pool(config) {
    return new Pool({...config,host:'127.0.0.1',ssl:false,max:1,connectionTimeoutMillis:1500,
      query_timeout:15000,idleTimeoutMillis:500,application_name:'carebridge-synthetic-e-check',
      options:'-c statement_timeout=10000 -c lock_timeout=5000 -c search_path=public,pg_catalog'});
  }

  async function inspectDirectory(directory) {
    await regularDirectoryChain(directory);
    await assert.rejects(lstat(join(directory,'postmaster.pid')),{code:'ENOENT'});
    const output = (await native(join(options.bin,'pg_controldata.exe'),['-D',directory],{cwd:root,rejectStderr:true})).replace(/\r\n/g,'\n');
    // No arbitrary command output is returned or embedded in assertion errors.
    const identifiers = [...output.matchAll(/^Database system identifier:[ \t]*([^\r\n]+)$/gm)];
    const states = [...output.matchAll(/^Database cluster state:[ \t]*([^\r\n]+)$/gm)];
    const systemIdentifier = identifiers[0]?.[1].trim(),state = states[0]?.[1].trim();
    if (identifiers.length !== 1 || states.length !== 1 || !systemIdentifierValid(systemIdentifier) || state !== 'shut down') throw retainedError();
    await regularDirectoryChain(directory);
    await assert.rejects(lstat(join(directory,'postmaster.pid')),{code:'ENOENT'});
    return Object.freeze({systemIdentifier,state});
  }

  // Internal admission after the storage layer has verified its dedicated
  // retained-session receipt, lock, secrets and file inventory. This is not a
  // general existing-cluster importer and never initializes, starts or seeds.
  async function registerRetainedCluster(input) {
    let directory,adminPassword,port,systemIdentifier;
    try {
      ({directory,adminPassword,port,systemIdentifier} = dataRecord(input,['directory','adminPassword','port','systemIdentifier']));
      if (directory !== join(root,'source') || typeof adminPassword !== 'string' || !/^[a-f0-9]{64}$/.test(adminPassword) ||
          !Number.isSafeInteger(port) || port < 1024 || port > 65535 || !systemIdentifierValid(systemIdentifier) ||
          registrations.has(directory) || clusters.some(item => item.directory.toLowerCase() === directory.toLowerCase() || item.port === port)) throw retainedError();
    } catch { throw retainedError(); }
    registrations.add(directory);
    try {
      const inspected = await inspectDirectory(directory);
      if (inspected.systemIdentifier !== systemIdentifier) throw retainedError();
      const cluster = {directory,port,adminPassword,password:null,child:null,exited:null,
        config:{host:'127.0.0.1',port,user:'carebridge_fixture_owner',password:null,database:'carebridge_synthetic'},roles:{}};
      retained.set(cluster,Object.freeze({directory,port,systemIdentifier}));
      owned.add(cluster); clusters.push(cluster);
      return cluster;
    } catch { throw retainedError(); }
    finally { registrations.delete(directory); }
  }

  async function inspectStoppedCluster(cluster) {
    if (!owned.has(cluster) || cluster.child !== null || inspections.has(cluster)) throw retainedError();
    inspections.add(cluster);
    try {
      const expected = retained.get(cluster);
      if (expected && (cluster.directory !== expected.directory || cluster.port !== expected.port)) throw retainedError();
      const inspected = await inspectDirectory(cluster.directory);
      if (cluster.child !== null || expected && inspected.systemIdentifier !== expected.systemIdentifier) throw retainedError();
      return inspected;
    } catch { throw retainedError(); }
    finally { inspections.delete(cluster); }
  }

  async function initializeCluster(directory) {
    // Only fresh direct descendants of the captured run root are admitted.
    assert.equal(dirname(resolve(directory)).toLowerCase(),resolve(root).toLowerCase());
    assert.ok(![...registrations].some(item => item.toLowerCase() === resolve(directory).toLowerCase()));
    assert.ok(!clusters.some((cluster) => resolve(cluster.directory).toLowerCase() === resolve(directory).toLowerCase()));
    await assert.rejects(lstat(directory),{code:'ENOENT'});
    const adminPassword = randomBytes(32).toString('hex'),password = randomBytes(32).toString('hex');
    const passwordFile = join(root,`init-password-${randomUUID()}.txt`),port = await freeLoopbackPort();
    const pendingSecret = {path:passwordFile,created:false}; pendingSecretFiles.add(pendingSecret);
    try {
      const handle = await open(passwordFile,'wx',0o600); pendingSecret.created = true;
      try { await handle.writeFile(`${adminPassword}\n`); await handle.sync(); } finally { await handle.close(); }
      await native(join(options.bin,'initdb.exe'),['-D',directory,'-U','carebridge_fixture_admin',`--pwfile=${passwordFile}`,
        '--auth-local=scram-sha-256','--auth-host=scram-sha-256','--encoding=UTF8','--locale-provider=builtin','--locale=C','--builtin-locale=C.UTF-8',
        '--data-checksums','--set','listen_addresses=127.0.0.1','--set',`port=${port}`,
        '--set','max_connections=12','--set','shared_buffers=32MB','--set','jit=off',
        '--set','fsync=on','--set','synchronous_commit=on','--set','full_page_writes=on',
        '--set','password_encryption=scram-sha-256','--set','log_statement=none',
        '--set','log_min_error_statement=panic','--set','log_min_messages=panic'],{cwd:root});
    } finally { await disposeInitPassword(pendingSecret); }
    await regularDirectoryChain(directory);
    const cluster = {directory,port,adminPassword,password,child:null,exited:null,
      config:{host:'127.0.0.1',port,user:'carebridge_fixture_owner',password,database:'carebridge_synthetic'},roles:{}};
    owned.add(cluster); clusters.push(cluster);
    await startCluster(cluster);
    const admin = pool({...cluster.config,user:'carebridge_fixture_admin',password:adminPassword,database:'postgres'});
    admin.on('error',() => {});
    try {
      await admin.query(`CREATE ROLE carebridge_fixture_owner LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      for (const role of roles) {
        const generated = randomBytes(32).toString('hex'); cluster.roles[role] = generated;
        await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${generated}'`);
      }
      await admin.query('CREATE DATABASE carebridge_synthetic OWNER carebridge_fixture_owner TEMPLATE template0');
    } finally { await admin.end(); }
    return cluster;
  }

  async function startCluster(cluster) {
    assert.ok(owned.has(cluster)); assert.equal(cluster.child,null);
    assert.ok(!inspections.has(cluster));
    const expected = retained.get(cluster);
    if (expected) {
      if (cluster.directory !== expected.directory || cluster.port !== expected.port || cluster.config.port !== expected.port) throw retainedError();
      await inspectStoppedCluster(cluster);
    }
    await regularDirectoryChain(cluster.directory);
    await assert.rejects(lstat(join(cluster.directory,'postmaster.pid')),{code:'ENOENT'});
    const child = spawn(join(options.bin,'postgres.exe'),['-D',cluster.directory],{
      cwd:cluster.directory,env:environment,shell:false,windowsHide:true,stdio:['ignore','ignore','ignore']});
    let ended = false,failed = false;
    const exited = new Promise((yes) => {
      child.on('error',() => { failed = true; });
      child.once('close',(exitCode,signalCode) => { ended = true; yes(Object.freeze({exitCode,signalCode})); });
    });
    cluster.child = child; cluster.exited = exited;
    const deadline = Date.now()+30000;
    while (Date.now() < deadline && !ended && !failed) {
      const probe = pool({...cluster.config,user:'carebridge_fixture_admin',password:cluster.adminPassword,database:'postgres'});
      probe.on('error',() => {});
      let ready = false;
      try {
        const {rows} = await probe.query(`SELECT current_setting('data_directory') AS directory,
          current_setting('server_version_num')::integer AS version,current_setting('listen_addresses') AS listen,
          current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS sync,
          current_setting('full_page_writes') AS page_writes,current_setting('data_checksums') AS checksums`);
        const row = rows[0];
        assert.equal(resolve(row.directory).toLowerCase(),resolve(cluster.directory).toLowerCase());
        assert.equal(row.version,180006); assert.equal(row.listen,'127.0.0.1');
        for (const name of ['fsync','sync','page_writes','checksums']) assert.equal(row[name],'on');
        if (expected) {
          const identity = await probe.query("SELECT system_identifier::text AS identifier, current_setting('port')::integer AS port FROM pg_control_system()");
          if (identity.rows.length !== 1 || identity.rows[0].identifier !== expected.systemIdentifier || identity.rows[0].port !== expected.port) throw retainedError();
        }
        const pid = (await readFile(join(cluster.directory,'postmaster.pid'),'utf8')).split(/\r?\n/)[0];
        assert.equal(Number(pid),child.pid);
        ready = true;
      } catch { /* Failed readiness is not permission to use another database. */ }
      finally { await probe.end(); }
      if (ready && !ended && !failed) return;
      if (ended || failed) break;
      await new Promise((yes) => setTimeout(yes,100));
    }
    throw new Error('WINDOWS_POSTGRES_START');
  }

  async function stopCluster(cluster) {
    assert.ok(owned.has(cluster)); if (!cluster.child) return;
    const child = cluster.child;
    if (child.exitCode === null && child.signalCode === null) {
      await regularDirectoryChain(cluster.directory);
      const pid = (await readFile(join(cluster.directory,'postmaster.pid'),'utf8')).split(/\r?\n/)[0];
      assert.equal(Number(pid),child.pid,'Only the direct process of this fresh cluster may be stopped');
      await native(join(options.bin,'pg_ctl.exe'),['stop','-D',cluster.directory,'-m','fast','-w','-t','20'],{cwd:cluster.directory,timeout:25000});
    }
    let timer;
    const completion = await Promise.race([cluster.exited,new Promise((_,no) => { timer = setTimeout(() => no(new Error('WINDOWS_POSTGRES_STOP')),5000); })]).finally(() => clearTimeout(timer));
    if (completion.exitCode !== 0 || completion.signalCode !== null || child.exitCode !== 0 || child.signalCode !== null) throw new Error('WINDOWS_POSTGRES_STOP');
    await assert.rejects(lstat(join(cluster.directory,'postmaster.pid')),{code:'ENOENT'});
    cluster.child = null;
  }

  return Object.freeze({native,freshFile,regularDirectoryChain,freeLoopbackPort,pool,initializeCluster,registerRetainedCluster,inspectStoppedCluster,startCluster,stopCluster,clusters,
    hasPendingSecrets:() => pendingSecretFiles.size > 0});
}
