// Process/filesystem/SQL protocol doubles only: no PostgreSQL, E access,
// native executable, Docker, credentials service or real listening socket.
import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {win32 as path} from 'node:path';
import {Pool} from 'pg';
import {createSyntheticPostgresRuntime,freshFile,regularDirectoryChain} from '../windows-synthetic-postgres-runtime.mjs';
import {windowsPostgresOptions,postgresCheckPaths,windowsPostgresEnvironment} from '../windows-postgres-policy.mjs';
const unavailable = {message:'WINDOWS_POSTGRES_CONFIGURATION'};
const tick = () => new Promise((yes) => setImmediate(yes));
const runId = 'b364d384-02e7-497c-9412-ca0c3778ea20';
const systemIdentifier = '7560000000000000123';
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
function configuration() {
  const options = {...windowsPostgresOptions(['--base','E:\\CarebridgeBeta','--powershell','C:\\Tools\\pwsh.exe','--confirm-synthetic-e-drive'])};
  return {options,root:postgresCheckPaths(options.privateRoot,runId).root,
    environment:windowsPostgresEnvironment({SYSTEMROOT:'C:\\Windows',TEMP:'C:\\SyntheticTemp'},options.bin),
    roles:['carebridge_fixture_runtime','carebridge_fixture_worker','carebridge_fixture_observer']};
}
const missing = () => Object.assign(new Error('SYNTHETIC_MISSING'),{code:'ENOENT'});
function fixture(t,input = configuration()) {
  const state = {directories:new Set(),files:new Map(),commands:[],children:[],queries:[],ended:0,
    handles:[],ports:new Map(),servers:[],nextPort:50000,pgCtlFailure:false,holdPgClose:false,keepPid:false,readyChange:null,nativeMode:null,
    startErrorBeforeClose:false,fileFailure:null,unlinkFailure:false,unlinks:[],onOpen:null,
    controlOutput:`pg_control version number:            1800\r\nDatabase system identifier:           ${systemIdentifier}\r\nDatabase cluster state:               shut down\r\n`,identityChange:null};
  for (let dir = input.root;; dir = path.dirname(dir)) { state.directories.add(dir); if (dir === path.dirname(dir)) break; }
  const stat = (isDirectory) => ({isDirectory:() => isDirectory,isSymbolicLink:() => false,isFile:() => !isDirectory});
  mock.method(fs,'lstat',async (name) => {
    if (state.files.has(name)) return stat(false);
    if (state.directories.has(name)) return stat(true);
    throw missing();
  });
  mock.method(fs,'realpath',async (name) => name);
  mock.method(fs,'readFile',async (name,encoding) => {
    if (!state.files.has(name)) throw missing(); const value = state.files.get(name);
    return encoding ? value.toString(encoding) : Buffer.from(value);
  });
  mock.method(fs,'unlink',async (name) => {
    state.unlinks.push(name); if (state.unlinkFailure) throw Object.assign(new Error('PRIVATE UNLINK'),{code:'EPERM'});
    if (!state.files.delete(name)) throw missing();
  });
  mock.method(fs,'open',async (name,flags,mode) => {
    assert.equal(flags,'wx'); assert.equal(mode,0o600);
    state.onOpen?.(name);
    if (state.fileFailure === 'open-missing') throw Object.assign(new Error('PRIVATE OPEN'),{code:'EACCES'});
    if (state.fileFailure === 'open-existing') state.files.set(name,Buffer.from('FOREIGN_SYNTHETIC'));
    if (state.files.has(name)) throw Object.assign(new Error('SYNTHETIC_EXISTS'),{code:'EEXIST'});
    state.files.set(name,Buffer.alloc(0));
    const handle = {name,closed:false,synced:false,
      async writeFile(bytes) { state.files.set(name,Buffer.from(bytes)); if (state.fileFailure === 'write') throw new Error('PRIVATE WRITE'); },
      async sync() { this.synced = true; if (state.fileFailure === 'sync') throw new Error('PRIVATE SYNC'); },
      async close() { this.closed = true; if (state.fileFailure === 'close') throw new Error('PRIVATE CLOSE'); }};
    state.handles.push(handle); return handle;
  });
  mock.method(net,'createServer',() => {
    const server = new EventEmitter();
    server.listen = (port,host,done) => { assert.equal(port,0); assert.equal(host,'127.0.0.1'); queueMicrotask(done); };
    server.address = () => ({port:++state.nextPort});
    server.close = (done) => { server.closed = true; queueMicrotask(() => done(null)); };
    state.servers.push(server); return server;
  });
  const finish = (child,code = 0) => { child.exitCode = code; child.emit('exit',code,null); child.emit('close',code,null); };
  const stopPg = (directory) => {
    const child = state.children.findLast((value) => value.directory === directory);
    if (!state.keepPid) state.files.delete(path.join(directory,'postmaster.pid'));
    finish(child);
  };
  mock.method(childProcess,'spawn',(command,args,options) => {
    const child = new EventEmitter(); Object.assign(child,{pid:40000+state.children.length,exitCode:null,signalCode:null,
      stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kills:0,kill() { this.kills++; return true; }});
    state.children.push(child); state.commands.push({command,args:[...args],options,child});
    const name = path.basename(command);
    if (name === 'postgres.exe') {
      child.directory = args[1]; state.files.set(path.join(child.directory,'postmaster.pid'),Buffer.from(`${child.pid}\n`));
    } else queueMicrotask(() => {
      if (state.nativeMode?.({command,args,options,child,finish}) === true) return;
      if (name === 'initdb.exe') {
        const directory = args[args.indexOf('-D')+1]; state.directories.add(directory);
        state.ports.set(Number(args.find((value) => value.startsWith('port=')).slice(5)),directory);
      }
      if (name === 'pg_ctl.exe') {
        if (state.pgCtlFailure) { child.stderr.write('PRIVATE Permission denied'); finish(child,1); return; }
        if (!state.holdPgClose) stopPg(args[args.indexOf('-D')+1]);
      }
      if (name === 'pg_controldata.exe') child.stdout.write(state.controlOutput);
      finish(child);
    });
    return child;
  });
  mock.method(Pool.prototype,'query',async function(sql) {
    state.queries.push(sql);
    if (sql.includes("current_setting('data_directory')")) {
      const directory = state.ports.get(this.options.port);
      const row = {directory,version:180006,listen:'127.0.0.1',fsync:'on',sync:'on',page_writes:'on',checksums:'on'};
      if (state.startErrorBeforeClose) {
        state.startErrorBeforeClose = false;
        const child = state.children.findLast((value) => value.directory === directory);
        queueMicrotask(() => child.emit('error',new Error('PRIVATE PG ERROR')));
      }
      if (state.readyChange) {
        state.readyChange(row);
        const child = state.children.findLast((value) => value.directory === directory); queueMicrotask(() => finish(child,7));
      }
      return {rows:[row]};
    }
    if (sql.includes('FROM pg_control_system()')) {
      const row = {identifier:systemIdentifier,port:this.options.port};
      if (state.identityChange) {
        state.identityChange(row);
        const child = state.children.findLast(value => value.directory === state.ports.get(this.options.port));
        queueMicrotask(() => finish(child,7));
      }
      return {rows:[row]};
    }
    return {rows:[]};
  });
  mock.method(Pool.prototype,'end',async () => { state.ended++; });
  syncBuiltinESMExports();
  t.after(() => { for (const child of state.children) for (const stream of [child.stdin,child.stdout,child.stderr]) stream.destroy(); });
  return {state,input,runtime:createSyntheticPostgresRuntime(input),finish,stopPg};
}

test('factory captures explicit configuration without filesystem process SQL or network work', (t) => {
  const f = fixture(t);
  assert.equal(f.state.commands.length,0); assert.equal(f.state.queries.length,0); assert.equal(f.state.servers.length,0);
  assert.equal(f.state.handles.length,0); assert.deepEqual(f.runtime.clusters,[]); assert.ok(Object.isFrozen(f.runtime));
  assert.equal(f.runtime.freshFile,freshFile); assert.equal(f.runtime.regularDirectoryChain,regularDirectoryChain);
});

test('invalid roots, roles, extra hooks, inherited secrets and accessors fail before IO', (t) => {
  const f = fixture(t),base = configuration(); let getters = 0;
  const accessor = Object.defineProperty({...base},'root',{get() { getters++; return base.root; }});
  const values = [null,{}, {...base,command:'arbitrary'}, {...base,root:path.dirname(base.root)},
    {...base,root:base.root+'\\..'}, {...base,root:base.root.replace('E:','C:')},
    {...base,options:{...base.options,bin:'C:\\other'}}, {...base,environment:{...base.environment,PGPASSWORD:'PRIVATE'}},
    {...base,roles:['carebridge_fixture_owner']},{...base,roles:['carebridge_fixture_admin']},
    {...base,roles:['role; SELECT']},{...base,roles:['carebridge_fixture_worker','carebridge_fixture_worker']},
    {...base,roles:new Array(1)},accessor];
  for (const value of values) assert.throws(() => createSyntheticPostgresRuntime(value),unavailable);
  assert.equal(getters,0); assert.equal(f.state.commands.length,0); assert.equal(f.state.handles.length,0);
});

test('freshFile is exclusive, synced and closed, and cannot overwrite an existing file',async (t) => {
  const f = fixture(t),name = path.join(f.input.root,'synthetic.txt');
  await f.runtime.freshFile(name,'synthetic');
  assert.equal(f.state.files.get(name).toString(),'synthetic'); assert.equal(f.state.handles[0].synced,true); assert.equal(f.state.handles[0].closed,true);
  await assert.rejects(f.runtime.freshFile(name,'changed'),{code:'EEXIST'});
  assert.equal(f.state.files.get(name).toString(),'synthetic');
});

test('regularDirectoryChain refuses a redirected ancestor before spawning',async (t) => {
  const f = fixture(t);
  mock.method(fs,'realpath',async (name) => name === path.dirname(f.input.root) ? 'E:\\foreign' : name); syncBuiltinESMExports();
  await assert.rejects(f.runtime.regularDirectoryChain(f.input.root),{code:'ERR_ASSERTION'});
  assert.equal(f.state.commands.length,0);
});

test('captured initialization preserves exact PostgreSQL locale durability and least-privileged role options',async (t) => {
  const input = configuration(),f = fixture(t,input),directory = path.join(input.root,'source'),originalBin = input.options.bin;
  input.options.bin = 'C:\\mutated'; input.environment.NODE_OPTIONS = '--import PRIVATE'; input.roles[0] = 'bad';
  const cluster = await f.runtime.initializeCluster(directory);
  assert.equal(f.runtime.clusters[0],cluster); assert.equal(cluster.config.host,'127.0.0.1');
  const init = f.state.commands.find((entry) => path.basename(entry.command) === 'initdb.exe');
  assert.equal(init.command,path.join(originalBin,'initdb.exe')); assert.equal(init.options.cwd,f.input.root);
  const passwordArg = init.args.find((arg) => arg.startsWith('--pwfile='));
  assert.deepEqual(init.args,['-D',directory,'-U','carebridge_fixture_admin',passwordArg,
    '--auth-local=scram-sha-256','--auth-host=scram-sha-256','--encoding=UTF8','--locale-provider=builtin','--locale=C','--builtin-locale=C.UTF-8',
    '--data-checksums','--set','listen_addresses=127.0.0.1','--set',`port=${cluster.port}`,
    '--set','max_connections=12','--set','shared_buffers=32MB','--set','jit=off','--set','fsync=on','--set','synchronous_commit=on',
    '--set','full_page_writes=on','--set','password_encryption=scram-sha-256','--set','log_statement=none',
    '--set','log_min_error_statement=panic','--set','log_min_messages=panic']);
  assert.equal(f.state.files.has(passwordArg.slice(9)),false); assert.ok(f.state.handles.every((handle) => handle.closed && handle.synced));
  assert.deepEqual(Object.keys(cluster.roles),['carebridge_fixture_runtime','carebridge_fixture_worker','carebridge_fixture_observer']);
  for (const command of f.state.commands) { assert.equal(command.options.shell,false); assert.equal(command.options.windowsHide,true); assert.equal(command.options.env.NODE_OPTIONS,undefined); }
  assert.equal(f.state.queries.filter((sql) => sql.startsWith('CREATE ROLE ')).length,4);
  for (const sql of f.state.queries.filter((sql) => sql.startsWith('CREATE ROLE ')))
    assert.match(sql,/LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '[a-f0-9]{64}'$/);
  assert.ok(f.state.queries.includes('CREATE DATABASE carebridge_synthetic OWNER carebridge_fixture_owner TEMPLATE template0'));
  await f.runtime.stopCluster(cluster); assert.equal(cluster.child,null);
});

test('pool preserves loopback and bounded checks even when callers supply relaxed config',async (t) => {
  const f = fixture(t),pool = f.runtime.pool({host:'external.invalid',ssl:true,max:20,application_name:'arbitrary',port:50001});
  assert.equal(pool.options.host,'127.0.0.1'); assert.equal(pool.options.ssl,false); assert.equal(pool.options.max,1);
  assert.equal(pool.options.connectionTimeoutMillis,1500); assert.equal(pool.options.query_timeout,15000); assert.equal(pool.options.idleTimeoutMillis,500);
  assert.equal(pool.options.application_name,'carebridge-synthetic-e-check');
  assert.equal(pool.options.options,'-c statement_timeout=10000 -c lock_timeout=5000 -c search_path=public,pg_catalog');
  await pool.end();
});

test('no cluster is adopted from an existing, nested or foreign directory',async (t) => {
  const f = fixture(t),directory = path.join(f.input.root,'source'); f.state.directories.add(directory);
  for (const target of [directory,f.input.root,path.join(f.input.root,'nested','source'),'E:\\foreign'])
    await assert.rejects(f.runtime.initializeCluster(target));
  assert.equal(f.state.commands.length,0); assert.equal(f.runtime.clusters.length,0);
});

test('initdb failure removes only its generated password file and exposes fixed diagnostic categories',async (t) => {
  const f = fixture(t);
  f.state.nativeMode = ({child,finish}) => { child.stderr.write('PRIVATE invalid locale name'); finish(child,1); return true; };
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')),(error) =>
    error.message === 'WINDOWS_POSTGRES_PROCESS' && error.category === 'LOCALE' && !JSON.stringify(error).includes('PRIVATE'));
  assert.equal(f.runtime.clusters.length,0); assert.equal(f.state.files.size,0); assert.ok(f.state.handles.every((handle) => handle.closed));
});

test('mismatched readiness preserves the direct child without accepting a different directory or weakened durability',async (t) => {
  const f = fixture(t); f.state.readyChange = (row) => { row.directory = 'E:\\foreign'; row.fsync = 'off'; };
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')),{message:'WINDOWS_POSTGRES_START'});
  assert.equal(f.runtime.clusters.length,1); assert.ok(f.runtime.clusters[0].child);
  assert.equal(f.state.queries.some((sql) => sql.startsWith('CREATE ROLE ')),false);
  await assert.rejects(f.runtime.stopCluster(f.runtime.clusters[0]));
  assert.ok(f.runtime.clusters[0].child); // A stale pid file must not be silently erased/adopted.
});

for (const [label,change] of [
  ['version',(row) => { row.version = 180005; }],['loopback',(row) => { row.listen = '*'; }],
  ...['fsync','sync','page_writes','checksums'].map((name) => [name,(row) => { row[name] = 'off'; }]),
]) test(`readiness independently refuses a changed ${label} invariant`,async (t) => {
  const f = fixture(t); f.state.readyChange = change;
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')),{message:'WINDOWS_POSTGRES_START'});
  assert.ok(f.runtime.clusters[0].child); assert.equal(f.state.queries.some((sql) => sql.startsWith('CREATE ROLE ')),false);
});

test('stop needs actual direct-child completion and missing pid, not pg_ctl acknowledgement alone',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),child = cluster.child;
  f.state.holdPgClose = true; let done = false;
  const pending = f.runtime.stopCluster(cluster).then(() => { done = true; });
  try {
    await tick(); assert.equal(done,false); assert.equal(cluster.child,child);
    const stop = f.state.commands.findLast((entry) => path.basename(entry.command) === 'pg_ctl.exe');
    assert.deepEqual(stop.args,['stop','-D',cluster.directory,'-m','fast','-w','-t','20']);
    f.stopPg(cluster.directory); await pending; assert.equal(cluster.child,null);
    await f.runtime.stopCluster(cluster); assert.equal(f.state.commands.filter((entry) => path.basename(entry.command) === 'pg_ctl.exe').length,1);
  } finally { if (!done) { f.stopPg(cluster.directory); await pending; } }
});

test('failed pg_ctl and a mismatched pid retain ownership and never kill a guessed process',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),child = cluster.child;
  f.state.pgCtlFailure = true;
  await assert.rejects(f.runtime.stopCluster(cluster),{message:'WINDOWS_POSTGRES_PROCESS'}); assert.equal(cluster.child,child);
  f.state.pgCtlFailure = false; f.state.files.set(path.join(cluster.directory,'postmaster.pid'),Buffer.from('999999\n'));
  const before = f.state.commands.length;
  await assert.rejects(f.runtime.stopCluster(cluster),{code:'ERR_ASSERTION'});
  assert.equal(f.state.commands.length,before); assert.equal(child.kills,0); assert.equal(cluster.child,child);
  f.state.files.set(path.join(cluster.directory,'postmaster.pid'),Buffer.from(`${child.pid}\n`)); await f.runtime.stopCluster(cluster);
});

test('stop observation timeout preserves its child handle rather than reporting or forcing termination',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),child = cluster.child;
  f.state.holdPgClose = true; t.mock.timers.enable({apis:['setTimeout']});
  const pending = f.runtime.stopCluster(cluster),rejected = assert.rejects(pending,{message:'WINDOWS_POSTGRES_STOP'});
  await tick(); t.mock.timers.tick(5001); await rejected;
  assert.equal(cluster.child,child); assert.equal(child.kills,0);
  assert.equal(f.state.files.has(path.join(cluster.directory,'postmaster.pid')),true);
  f.stopPg(cluster.directory); await f.runtime.stopCluster(cluster); assert.equal(cluster.child,null);
});

test('stopped clusters can explicitly restart, while foreign objects and other factories cannot control them',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),first = cluster.child;
  const other = createSyntheticPostgresRuntime(configuration());
  await assert.rejects(other.stopCluster(cluster)); await assert.rejects(f.runtime.startCluster({...cluster,child:null}));
  await f.runtime.stopCluster(cluster); await f.runtime.startCluster(cluster);
  assert.notEqual(cluster.child,first); assert.equal(cluster.config.database,'carebridge_synthetic');
  await f.runtime.stopCluster(cluster); assert.equal(cluster.child,null);
});

test('each fresh cluster gets distinct passwords and a non-reused loopback port',async (t) => {
  const f = fixture(t),first = await f.runtime.initializeCluster(path.join(f.input.root,'source'));
  f.state.nextPort = first.port-1;
  const second = await f.runtime.initializeCluster(path.join(f.input.root,'restored'));
  assert.notEqual(first.port,second.port); assert.notEqual(first.password,second.password); assert.notEqual(first.adminPassword,second.adminPassword);
  assert.ok(f.state.servers.every((server) => server.closed));
  await f.runtime.stopCluster(second); await f.runtime.stopCluster(first);
});

test('native output errors remain bounded fixed categories and successful stdout behavior is preserved',async (t) => {
  const f = fixture(t);
  f.state.nativeMode = ({child,finish}) => { child.stdout.write(' synthetic result \n'); finish(child); return true; };
  assert.equal(await f.runtime.native('C:\\synthetic.exe',[]),'synthetic result');
  f.state.nativeMode = ({child,finish}) => { child.stderr.write('PRIVATE unrecognized configuration parameter'); finish(child,7); return true; };
  await assert.rejects(f.runtime.native('C:\\synthetic.exe',[]),(error) => error.exitCode === 7 && error.category === 'SETTING' &&
    error.message === 'WINDOWS_POSTGRES_PROCESS' && error.cause === undefined && !JSON.stringify(error).includes('PRIVATE') &&
    error.timedOut === false && error.outputExceeded === false && error.spawnFailed === false);
});

test('native output overflow refuses even a zero exit and timer expiration still waits for child close',async (t) => {
  const f = fixture(t);
  f.state.nativeMode = ({child,finish}) => { child.stdout.write(Buffer.alloc(4*1024*1024+1,65)); finish(child); return true; };
  await assert.rejects(f.runtime.native('C:\\synthetic.exe',[]),{message:'WINDOWS_POSTGRES_PROCESS',
    timedOut:false,outputExceeded:true,spawnFailed:false});
  assert.equal(f.state.children.at(-1).kills,1);
  f.state.nativeMode = () => true;
  let settled = false;
  const pending = f.runtime.native('C:\\synthetic.exe',[],{timeout:5}).finally(() => { settled = true; });
  const rejected = assert.rejects(pending,{message:'WINDOWS_POSTGRES_PROCESS',
    timedOut:true,outputExceeded:false,spawnFailed:false});
  await new Promise((yes) => setTimeout(yes,20)); assert.equal(settled,false);
  const child = f.state.children.at(-1); assert.equal(child.kills,1); f.finish(child); await rejected;
});

test('native synchronous spawn failure exposes only fixed observations, never raw arguments or cause',async (t) => {
  const f = fixture(t);
  mock.method(childProcess,'spawn',() => { throw new Error('PRIVATE command argument and environment'); });
  syncBuiltinESMExports();
  await assert.rejects(f.runtime.native('C:\\PRIVATE.exe',['PRIVATE_ARG']),error => {
    assert.equal(error.message,'WINDOWS_POSTGRES_PROCESS');
    assert.deepEqual({...error},{exitCode:null,category:'NATIVE_COMMAND',timedOut:false,outputExceeded:false,spawnFailed:true});
    assert.equal(error.cause,undefined); assert.equal(JSON.stringify(error).includes('PRIVATE'),false);
    return true;
  });
  assert.equal(f.state.children.length,0);
});

test('native combined output ceiling still accepts its boundary and rejects one additional stderr byte',async (t) => {
  const f = fixture(t),bytes = Buffer.alloc(4*1024*1024-8,65);
  f.state.nativeMode = ({child,finish}) => { child.stdout.write(bytes); child.stderr.write('12345678'); finish(child); return true; };
  assert.equal((await f.runtime.native('C:\\synthetic.exe',[])).length,bytes.length);
  assert.equal(f.state.children.at(-1).kills,0);
  f.state.nativeMode = ({child,finish}) => { child.stdout.write(bytes); child.stderr.write('123456789'); finish(child); return true; };
  await assert.rejects(f.runtime.native('C:\\synthetic.exe',[]),{message:'WINDOWS_POSTGRES_PROCESS',
    timedOut:false,outputExceeded:true,spawnFailed:false});
  assert.equal(f.state.children.at(-1).kills,1);
});

test('native timeout and output excess are independent observations and never settle before close',async (t) => {
  const f = fixture(t); f.state.nativeMode = () => true; t.mock.timers.enable({apis:['setTimeout']});
  let settled = false;
  const pending = f.runtime.native('C:\\synthetic.exe',[],{timeout:5}).finally(() => { settled = true; });
  const rejected = assert.rejects(pending,error => {
    assert.deepEqual({...error},{exitCode:0,category:'NATIVE_COMMAND',timedOut:true,outputExceeded:true,spawnFailed:false});
    assert.equal(error.cause,undefined); assert.equal(JSON.stringify(error).includes('PRIVATE'),false);
    return true;
  });
  const child = f.state.children.at(-1);
  child.stdout.write(Buffer.alloc(4*1024*1024+1,65));
  child.stdout.write('PRIVATE trailing output after overflow');
  t.mock.timers.tick(6); await tick(); assert.equal(settled,false);
  f.finish(child); await rejected;
});

for (const pid of [undefined,41000]) test(`native error with ${pid === undefined ? 'no' : 'assigned'} PID waits for actual close and never turns a later zero exit into success`,async (t) => {
  const f = fixture(t); f.state.nativeMode = () => true; let settled = false;
  const pending = f.runtime.native('C:\\synthetic.exe',[]).finally(() => { settled = true; });
  const rejected = assert.rejects(pending,(error) => error.message === 'WINDOWS_POSTGRES_PROCESS' && !JSON.stringify(error).includes('PRIVATE') &&
    error.spawnFailed === (pid === undefined) && error.timedOut === false && error.outputExceeded === false);
  const child = f.state.children.at(-1); child.pid = pid; child.emit('error',new Error('PRIVATE SPAWN ERROR'));
  await tick(); assert.equal(settled,false);
  child.emit('error',new Error('PRIVATE SECOND ERROR')); await tick(); assert.equal(settled,false);
  f.finish(child,0); await rejected; assert.equal(settled,true);
});

for (const mode of ['false','throw']) test(`native error followed by timeout and kill ${mode} is not terminal before close`,async (t) => {
  const f = fixture(t); f.state.nativeMode = () => true; t.mock.timers.enable({apis:['setTimeout']}); let settled = false;
  const pending = f.runtime.native('C:\\synthetic.exe',[],{timeout:5}).finally(() => { settled = true; });
  const rejected = assert.rejects(pending,{message:'WINDOWS_POSTGRES_PROCESS',
    timedOut:true,outputExceeded:false,spawnFailed:false});
  const child = f.state.children.at(-1);
  child.kill = () => { child.kills++; if (mode === 'throw') throw new Error('PRIVATE KILL'); return false; };
  child.emit('error',new Error('PRIVATE ERROR')); t.mock.timers.tick(6); await tick();
  assert.equal(child.kills,1); assert.equal(settled,false);
  f.finish(child,1); await rejected; assert.equal(settled,true);
});

test('PG startup error exits readiness but preserves unresolved child lifetime until close',async (t) => {
  const f = fixture(t); f.state.startErrorBeforeClose = true;
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')),{message:'WINDOWS_POSTGRES_START'});
  const cluster = f.runtime.clusters[0],child = cluster.child; let closed = false;
  cluster.exited.then(() => { closed = true; }); await tick();
  assert.equal(closed,false); assert.equal(cluster.child,child); assert.equal(f.state.queries.some((sql) => sql.startsWith('CREATE ROLE ')),false);
  await f.runtime.stopCluster(cluster); assert.equal(closed,true); assert.equal(cluster.child,null);
});

test('init password ownership is pending before exclusive creation and cleared only after confirmed absence',async (t) => {
  const f = fixture(t),observed = [];
  f.state.onOpen = () => observed.push(f.runtime.hasPendingSecrets());
  assert.equal(f.runtime.hasPendingSecrets(),false);
  const cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source'));
  assert.deepEqual(observed,[true]); assert.equal(f.runtime.hasPendingSecrets(),false);
  assert.equal(f.state.files.size,1); // Only the synthetic postmaster.pid remains.
  await f.runtime.stopCluster(cluster);
});

for (const mode of ['write','sync','close']) test(`init password ${mode} failure retains the pending secret when deletion fails before cluster registration`,async (t) => {
  const f = fixture(t); f.state.fileFailure = mode; f.state.unlinkFailure = true;
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')));
  assert.equal(f.runtime.clusters.length,0); assert.equal(f.state.commands.length,0);
  assert.equal(f.runtime.hasPendingSecrets(),true); assert.equal(f.state.files.size,1);
  assert.equal(typeof f.runtime.hasPendingSecrets(),'boolean');
});

test('successful initdb followed by unconfirmed password removal remains pending before cluster registration',async (t) => {
  const f = fixture(t); f.state.unlinkFailure = true;
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')));
  assert.equal(f.state.commands.length,1); assert.equal(path.basename(f.state.commands[0].command),'initdb.exe');
  assert.equal(f.runtime.clusters.length,0); assert.equal(f.runtime.hasPendingSecrets(),true);
});

test('failed write followed by successful deletion and ENOENT does not leave a false pending secret',async (t) => {
  const f = fixture(t); f.state.fileFailure = 'write';
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')));
  assert.equal(f.runtime.hasPendingSecrets(),false); assert.equal(f.state.files.size,0); assert.equal(f.state.commands.length,0);
});

test('exclusive create failure clears pending only for ENOENT and never removes a foreign existing file',async (t) => {
  const f = fixture(t); f.state.fileFailure = 'open-missing';
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'source')));
  assert.equal(f.runtime.hasPendingSecrets(),false); assert.equal(f.state.unlinks.length,0);
  f.state.fileFailure = 'open-existing';
  await assert.rejects(f.runtime.initializeCluster(path.join(f.input.root,'restored')),{message:'WINDOWS_POSTGRES_SECRET_PENDING'});
  assert.equal(f.runtime.hasPendingSecrets(),true); assert.equal(f.state.unlinks.length,0);
  assert.deepEqual([...f.state.files.values()].map((bytes) => bytes.toString()),['FOREIGN_SYNTHETIC']);
});

function retainedInput(f) {
  const directory = path.join(f.input.root,'source'),port = 50501;
  f.state.directories.add(directory); f.state.ports.set(port,directory);
  return {directory,adminPassword:'a'.repeat(64),port,systemIdentifier};
}

test('retained admission only inspects a clean direct source with saved identity and port; it never starts or initializes',async (t) => {
  const f = fixture(t),input = retainedInput(f),cluster = await f.runtime.registerRetainedCluster(input);
  assert.equal(cluster.child,null); assert.equal(cluster.port,input.port); assert.equal(cluster.adminPassword,input.adminPassword);
  assert.equal(cluster.config.password,null); assert.deepEqual(cluster.roles,{});
  assert.equal(f.runtime.clusters[0],cluster); assert.equal(f.state.servers.length,0); assert.equal(f.state.queries.length,0);
  assert.equal(f.state.handles.length,0); assert.equal(f.state.unlinks.length,0);
  assert.deepEqual(f.state.commands.map(value => path.basename(value.command)),['pg_controldata.exe']);
  assert.deepEqual(f.state.commands[0].args,['-D',input.directory]);
  assert.equal(f.state.commands[0].options.cwd,f.input.root); assert.equal(f.state.commands[0].options.env.LANG,'C');
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  await assert.rejects(f.runtime.initializeCluster(input.directory));
  assert.equal(f.state.commands.length,1);
});

test('retained admission rejects foreign paths, invalid credentials ports identifiers and accessors before command execution',async (t) => {
  const f = fixture(t),input = retainedInput(f); let getters = 0;
  const accessor = Object.defineProperty({...input},'adminPassword',{get() { getters++; return input.adminPassword; }});
  const bad = [null,{}, {...input,extra:true},accessor,
    ...[f.input.root,path.join(f.input.root,'restored'),path.join(f.input.root,'nested','source'),'E:\\foreign',input.directory+'\\..\\source'].map(directory => ({...input,directory})),
    ...['','a'.repeat(63),'A'.repeat(64),'a'.repeat(63)+'\n',Buffer.alloc(64)].map(adminPassword => ({...input,adminPassword})),
    ...[0,1023,65536,50501.5,'50501',NaN,Infinity].map(port => ({...input,port})),
    ...['0','01','-1','1e3','18446744073709551616',7560000000000000123,'1\n',null].map(value => ({...input,systemIdentifier:value}))];
  for (const value of bad) await assert.rejects(f.runtime.registerRetainedCluster(value),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(getters,0); assert.equal(f.state.commands.length,0); assert.equal(f.runtime.clusters.length,0);
});

for (const [label,output] of [
  ['running',`Database system identifier: ${systemIdentifier}\nDatabase cluster state: in production`],
  ['recovering',`Database system identifier: ${systemIdentifier}\nDatabase cluster state: shut down in recovery`],
  ['wrong identity','Database system identifier: 7560000000000000124\nDatabase cluster state: shut down'],
  ['missing state',`Database system identifier: ${systemIdentifier}`],
  ['duplicate identity',`Database system identifier: ${systemIdentifier}\nDatabase system identifier: ${systemIdentifier}\nDatabase cluster state: shut down`],
  ['duplicate state',`Database system identifier: ${systemIdentifier}\nDatabase cluster state: shut down\nDatabase cluster state: shut down`],
  ['malformed','PRIVATE PATH OR COMMAND CONTENT'],
]) test(`retained admission refuses ${label} offline evidence with fixed error and no registration`,async (t) => {
  const f = fixture(t),input = retainedInput(f); f.state.controlOutput = output;
  await assert.rejects(f.runtime.registerRetainedCluster(input),error => error.message === 'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE' &&
    error.cause === undefined && !JSON.stringify(error).includes('PRIVATE'));
  assert.equal(f.runtime.clusters.length,0); assert.equal(f.state.queries.length,0); assert.equal(f.state.unlinks.length,0);
});

test('retained admission refuses existing PID files and redirected directory chains without removing anything',async (t) => {
  const f = fixture(t),input = retainedInput(f),pid = path.join(input.directory,'postmaster.pid');
  f.state.files.set(pid,Buffer.from('999999\n'));
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.state.commands.length,0); assert.equal(f.state.files.has(pid),true); f.state.files.delete(pid);
  mock.method(fs,'realpath',async name => name === input.directory ? 'E:\\foreign' : name); syncBuiltinESMExports();
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.state.commands.length,0); assert.equal(f.state.unlinks.length,0); assert.equal(f.runtime.clusters.length,0);
});

test('retained offline command failure or a new PID file after inspection never admits a cluster',async (t) => {
  const f = fixture(t),input = retainedInput(f);
  f.state.nativeMode = ({child,finish}) => { child.stderr.write('PRIVATE NATIVE PATH'); finish(child,1); return true; };
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  f.state.nativeMode = ({child,finish}) => {
    child.stdout.write(f.state.controlOutput); f.state.files.set(path.join(input.directory,'postmaster.pid'),Buffer.from('999999\n'));
    finish(child); return true;
  };
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.runtime.clusters.length,0); assert.equal(f.state.unlinks.length,0); assert.equal(f.state.queries.length,0);
});

test('retained admission captures input before awaiting and rejects concurrent registration',async (t) => {
  const f = fixture(t),input = retainedInput(f),original = {...input}; let settle;
  f.state.nativeMode = ({child,finish}) => { settle = () => { child.stdout.write(f.state.controlOutput); finish(child); }; return true; };
  const pending = f.runtime.registerRetainedCluster(input); await tick();
  await assert.rejects(f.runtime.registerRetainedCluster(original),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  input.directory = 'E:\\foreign'; input.port = 9; input.adminPassword = ''; input.systemIdentifier = '1';
  settle(); const cluster = await pending;
  assert.equal(cluster.directory,original.directory); assert.equal(cluster.port,original.port); assert.equal(cluster.adminPassword,original.adminPassword);
  assert.equal(f.state.commands.length,1); assert.equal(f.runtime.clusters.length,1);
});

test('retained start validates the same saved port and SQL system identifier without DDL or a new port',async (t) => {
  const f = fixture(t),input = retainedInput(f),cluster = await f.runtime.registerRetainedCluster(input);
  await f.runtime.startCluster(cluster);
  assert.ok(cluster.child); assert.equal(cluster.port,input.port); assert.equal(f.state.servers.length,0);
  assert.equal(f.state.queries.some(sql => /CREATE|ALTER|INSERT|UPDATE|DELETE/.test(sql)),false);
  assert.equal(f.state.queries.filter(sql => sql.includes('FROM pg_control_system()')).length,1);
  assert.deepEqual(f.state.commands.find(value => path.basename(value.command) === 'postgres.exe').args,['-D',input.directory]);
  await f.runtime.stopCluster(cluster);
  const inspected = await f.runtime.inspectStoppedCluster(cluster);
  assert.deepEqual(inspected,{systemIdentifier,state:'shut down'}); assert.ok(Object.isFrozen(inspected));
});

for (const [label,change] of [
  ['system identifier',row => { row.identifier = '7560000000000000124'; }],
  ['numeric identifier',row => { row.identifier = Number(systemIdentifier); }],
  ['saved port',row => { row.port++; }],
]) test(`retained readiness refuses a different ${label} and retains the failed child`,async (t) => {
  const f = fixture(t),cluster = await f.runtime.registerRetainedCluster(retainedInput(f)); f.state.identityChange = change;
  await assert.rejects(f.runtime.startCluster(cluster),{message:'WINDOWS_POSTGRES_START'});
  assert.ok(cluster.child); await assert.rejects(f.runtime.stopCluster(cluster),{message:'WINDOWS_POSTGRES_STOP'});
  assert.ok(cluster.child); assert.equal(f.state.queries.some(sql => /CREATE|ALTER|INSERT|UPDATE|DELETE/.test(sql)),false);
});

test('retained start refuses mutated captured path or port before spawning',async (t) => {
  const f = fixture(t),input = retainedInput(f),cluster = await f.runtime.registerRetainedCluster(input),before = f.state.commands.length;
  cluster.directory = 'E:\\foreign'; await assert.rejects(f.runtime.startCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  cluster.directory = input.directory; cluster.port++; await assert.rejects(f.runtime.startCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  cluster.port = input.port; cluster.config.port++; await assert.rejects(f.runtime.startCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.state.commands.length,before); assert.equal(cluster.child,null);
});

test('stopped inspection supports a fresh owned cluster but refuses active and foreign objects',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source'));
  await assert.rejects(f.runtime.inspectStoppedCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  await f.runtime.stopCluster(cluster); const before = f.state.queries.length;
  assert.deepEqual(await f.runtime.inspectStoppedCluster(cluster),{systemIdentifier,state:'shut down'});
  assert.equal(f.state.queries.length,before);
  await assert.rejects(f.runtime.inspectStoppedCluster({...cluster}),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  await assert.rejects(createSyntheticPostgresRuntime(configuration()).inspectStoppedCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
});

test('inspection cannot overlap a start or another inspection and rechecks retained identity',async (t) => {
  const f = fixture(t),input = retainedInput(f),cluster = await f.runtime.registerRetainedCluster(input); let settle;
  f.state.nativeMode = ({child,finish}) => { settle = () => { child.stdout.write(f.state.controlOutput); finish(child); }; return true; };
  const pending = f.runtime.inspectStoppedCluster(cluster); await tick();
  await assert.rejects(f.runtime.startCluster(cluster));
  await assert.rejects(f.runtime.inspectStoppedCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  settle(); await pending; f.state.nativeMode = null;
  f.state.controlOutput = f.state.controlOutput.replace(systemIdentifier,'7560000000000000124');
  await assert.rejects(f.runtime.inspectStoppedCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  await assert.rejects(f.runtime.startCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.state.commands.some(value => path.basename(value.command) === 'postgres.exe'),false);
});

for (const [exitCode,signalCode] of [[1,null],[null,'SIGTERM']]) test(`stop refuses abnormal actual termination ${exitCode ?? 'signal'} even after PID disappearance`,async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),child = cluster.child;
  f.state.files.delete(path.join(cluster.directory,'postmaster.pid')); child.exitCode = exitCode; child.signalCode = signalCode;
  child.emit('exit',exitCode,signalCode); child.emit('close',exitCode,signalCode);
  await assert.rejects(f.runtime.stopCluster(cluster),{message:'WINDOWS_POSTGRES_STOP'});
  assert.equal(cluster.child,child); await assert.rejects(f.runtime.inspectStoppedCluster(cluster),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
});

test('a zero exit event alone does not replace the actual close gate',async (t) => {
  const f = fixture(t),cluster = await f.runtime.initializeCluster(path.join(f.input.root,'source')),child = cluster.child;
  f.state.files.delete(path.join(cluster.directory,'postmaster.pid')); child.exitCode = 0; child.emit('exit',0,null);
  let done = false; const pending = f.runtime.stopCluster(cluster).then(() => { done = true; }); await tick();
  assert.equal(done,false); assert.equal(cluster.child,child);
  child.emit('close',0,null); await pending; assert.equal(cluster.child,null);
});

test('offline control warnings refuse clean-looking zero-exit output while ordinary native stdout behavior remains compatible',async (t) => {
  const f = fixture(t),input = retainedInput(f);
  f.state.nativeMode = ({child,finish}) => {
    child.stdout.write(f.state.controlOutput); child.stderr.write('PRIVATE CONTROL CHECKSUM WARNING'); finish(child); return true;
  };
  await assert.rejects(f.runtime.registerRetainedCluster(input),{message:'WINDOWS_POSTGRES_RETAINED_UNAVAILABLE'});
  assert.equal(f.runtime.clusters.length,0);
  assert.equal(await f.runtime.native('C:\\synthetic.exe',[]),f.state.controlOutput.trim());
  await assert.rejects(f.runtime.native('C:\\synthetic.exe',[],{rejectStderr:true}),error =>
    error.message === 'WINDOWS_POSTGRES_PROCESS' && error.exitCode === 0 && !JSON.stringify(error).includes('PRIVATE'));
});
