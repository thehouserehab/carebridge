import test,{mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Pool} from 'pg';
import {WindowsDatabaseCredentialStore} from '../windows-database-credential-store.mjs';
import {windowsDatabaseServiceOptions,openWindowsDatabaseService,WINDOWS_DATABASE_STAGES} from '../windows-database-service.mjs';
import {serviceInput,serviceCatalog} from './database-service-fixtures.mjs';

afterEach(() => mock.restoreAll());
const input=() => ({storage:{base:'E:\\CarebridgeBeta',powershell:'C:\\Tools\\pwsh.exe',syntheticRunId:randomUUID()},
  credentialId:randomUUID(),privileges:serviceInput(),kind:'worker',endpoint:{host:'127.0.0.1',port:54321}});
const unavailable={message:'DATABASE_SERVICE_UNAVAILABLE'};
const fails=(value) => assert.throws(() => windowsDatabaseServiceOptions(value),unavailable);

test('explicit five-role/E credential configuration produces a captured frozen loopback-only TLS connection',() => {
  const original=input(),options=windowsDatabaseServiceOptions(original);
  original.endpoint.host='192.0.2.1';original.privileges.roles.worker='other';original.storage.base='E:\\Other';
  assert.equal(options.connection.host,'127.0.0.1');assert.equal(options.connection.user,'cb_worker');assert.equal(options.connection.database,'cb_synthetic');
  assert.equal(options.connection.ssl.rejectUnauthorized,true);assert.equal(options.connection.ssl.minVersion,'TLSv1.2');
  assert.equal(options.connection.sslnegotiation,'postgres');assert.equal(options.connection.enableChannelBinding,true);
  assert.equal(options.connection.client_encoding,'UTF8');assert.equal(options.connection.replication,'false');
  assert.ok(Object.isFrozen(options)&&Object.isFrozen(options.connection)&&Object.isFrozen(options.connection.ssl)&&Object.isFrozen(options.storage));
  for(const name of ['password','connectionString','Client','onConnect','sslmode','hostaddr'])assert.equal(Object.hasOwn(options.connection,name),false);
});
test('non-TLS needs both a literal loopback address and explicit synthetic-only custody path',() => {
  for(const host of ['127.0.0.1','::1']) {
    const value=input();value.endpoint={host,port:54321,transport:'synthetic-loopback'};assert.equal(windowsDatabaseServiceOptions(value).connection.ssl,false);
    delete value.storage.syntheticRunId;fails(value);
  }
  const value=input();value.endpoint.transport='synthetic-loopback';value.endpoint.ca='not-accepted';fails(value);
});
test('missing defaults, URL/socket/DNS/remote addresses, coerced ports and unsafe transport overrides are refused',() => {
  for(const host of ['localhost','[::1]','127.1','127.0.0.2','192.0.2.1','db.example.invalid','/tmp/socket','postgres://u:p@127.0.0.1/db']) {
    const value=input();value.endpoint.host=host;fails(value);
  }
  for(const port of [undefined,null,'5432',0,65536,1.5]){const value=input();value.endpoint.port=port;fails(value);}
  for(const patch of [{ssl:false},{ssl:{rejectUnauthorized:false}},{connectionString:'private'},{transport:false},{transport:null},{transport:undefined},{transport:'prefer'},
    {checkServerIdentity:() => {}},{servername:'other'},{ca:null},{ca:'invalid certificate'}]){const value=input();Object.assign(value.endpoint,patch);fails(value);}
  for(const patch of [{password:'never'},{database:{}},{createDatabase:() => {}},{credentialStore:{}},{force:true},{kind:'owner'}])fails({...input(),...patch});
  const value=input();delete value.endpoint.port;fails(value);delete value.endpoint;fails(value);
});
test('TLS certificate identity check always binds to the explicit IP, not driver/DNS servername',() => {
  const check=windowsDatabaseServiceOptions(input()).connection.ssl.checkServerIdentity;
  assert.equal(check('wrong.example.invalid',{subjectaltname:'IP Address:127.0.0.1'}),undefined);
  assert.equal(check('localhost',{subjectaltname:'IP Address:192.0.2.1'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(check('127.0.0.1',{subjectaltname:'DNS:localhost'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
});

// Explicit protocol/driver doubles only. Prototype mocks are restored after
// every test; the product factory has no injected pool/store/bypass option.
async function fixture({kind='worker',load,end,connect,commitFail=false}={}) {
  const catalog=serviceCatalog();catalog.state.kind=kind;let query;
  await catalog.database.transaction((tx) => {query=tx.query;});
  const state={pools:[],loads:[],buffers:[],ended:0,queries:[],released:0};
  mock.method(WindowsDatabaseCredentialStore.prototype,'load',async function(...args) {
    state.loads.push(args);const buffer=load ? await load(state) : Buffer.alloc(64,65);state.buffers.push(buffer);return buffer;
  });
  mock.method(Pool.prototype,'connect',async function() {
    if(!state.pools.includes(this))state.pools.push(this);await connect?.(state,this);
    const password=await this.options.password();assert.equal(typeof password,'string');
    const client=Object.assign(new EventEmitter(),{
      query:async(sql,params) => {
        state.queries.push(sql);
        if(sql==='COMMIT' && commitFail)throw new Error('private synthetic commit');
        if(['BEGIN','COMMIT','ROLLBACK','SET TRANSACTION READ ONLY'].includes(sql))return {rows:[]};
        if(sql==='SELECT $1')return {rows:[{value:params[0]}]};
        return query(sql,params);
      },release:() => {state.released++;},
    });return client;
  });
  mock.method(Pool.prototype,'end',async function(){state.ended++;await end?.(state);});
  return {catalog,state};
}
test('factory owns a guarded private pool, makes a read-only admission and preserves scoped work results',async () => {
  if(process.platform!=='win32'){await assert.rejects(openWindowsDatabaseService(input()),unavailable);return;}
  const {state}=await fixture(),value=input(),service=await openWindowsDatabaseService(value);
  assert.ok(Object.isFrozen(service));assert.deepEqual(Object.keys(service).sort(),['close','isAvailable','transaction']);
  assert.equal(state.queries.includes('SET TRANSACTION READ ONLY'),true);assert.equal(state.queries.some((sql) => /^(GRANT|REVOKE|ALTER|CREATE)/.test(sql)),false);
  assert.equal(await service.transaction(async(tx) => (await tx.query('SELECT $1',['synthetic'])).rows[0].value),'synthetic');
  assert.ok(state.buffers.every((bytes) => bytes.every((byte) => byte===0)));assert.equal(service.isAvailable(),true);
  const first=service.close(),second=service.close();assert.equal(first,second);await first;assert.equal(state.ended,1);
  await assert.rejects(service.transaction(() => assert.fail('closed')),unavailable);assert.equal(service.isAvailable(),false);
});
test('all four non-owner service purposes use their own captured credential/role and each connection reloads secret bytes',async () => {
  if(process.platform!=='win32')return;
  const {catalog,state}=await fixture();
  for(const kind of ['runtime','bootstrap','backup','worker']) {
    catalog.state.kind=kind;const value=input();value.kind=kind;
    const service=await openWindowsDatabaseService(value);await service.transaction(() => {});await service.close();
    assert.equal(state.loads.at(-1)[2],kind);assert.equal(state.pools.at(-1).options.user,value.privileges.roles[kind]);
  }
  assert.equal(state.loads.length,8);assert.equal(state.ended,4);assert.ok(state.buffers.every((bytes) => bytes.every((byte) => byte===0)));
});
test('bad owner/options are rejected before any credential/DB access',async () => {
  const {state}=await fixture();await assert.rejects(openWindowsDatabaseService({...input(),kind:'owner'}),unavailable);
  const value=input();delete value.storage.syntheticRunId;value.endpoint.transport='synthetic-loopback';
  await assert.rejects(openWindowsDatabaseService(value),unavailable);assert.equal(state.loads.length,0);assert.equal(state.pools.length,0);assert.equal(state.ended,0);
});
test('missing/native/invalid credential failures and private connection errors close without fallback or raw errors',async () => {
  if(process.platform!=='win32')return;
  for(const patch of [{load:async() => {throw new Error('private synthetic credential');}},{load:async() => Buffer.alloc(64)},
    {connect:async() => {throw new Error('private synthetic connection');}}]) {
    const {state}=await fixture(patch);await assert.rejects(openWindowsDatabaseService(input()),(error) => error.message===unavailable.message && error.cause===undefined);
    assert.equal(state.ended,1);assert.ok(state.buffers.every((bytes) => bytes.every((byte) => byte===0)));mock.restoreAll();
  }
});
test('startup role/target/privilege or commit failure is generic and closes the pool exactly once',async () => {
  if(process.platform!=='win32')return;
  for(const mode of ['role','target','privilege','commit']) {
    const {catalog,state}=await fixture({kind:mode==='role'?'runtime':'worker',commitFail:mode==='commit'}),value=input();
    if(mode==='target')value.privileges.target.oid++;
    if(mode==='privilege')catalog.state.grantedBody=true;
    await assert.rejects(openWindowsDatabaseService(value),unavailable);assert.equal(state.ended,1);mock.restoreAll();
  }
});
test('capture before first await prevents later options/plan mutation from changing the connection',async () => {
  if(process.platform!=='win32')return;
  let release;const gate=new Promise((yes) => {release=yes;});const {state}=await fixture({load:async() => {await gate;return Buffer.alloc(64,65);}});
  const value=input(),expected=structuredClone(value),pending=openWindowsDatabaseService(value);
  await new Promise((yes) => setImmediate(yes));value.kind='runtime';value.endpoint.host='192.0.2.1';value.privileges.roles.worker='other';value.storage.base='E:\\Other';
  release();const service=await pending;assert.equal(state.loads[0][0],expected.credentialId);assert.equal(state.loads[0][1].roles.worker,'cb_worker');
  assert.equal(state.pools[0].options.host,'127.0.0.1');await service.close();
});
test('background failure prevents new work and caller work errors retain the existing internal contract',async () => {
  if(process.platform!=='win32')return;
  const {state}=await fixture(),service=await openWindowsDatabaseService(input()),privateWorkError=new Error('internal business error');
  await assert.rejects(service.transaction(() => {throw privateWorkError;}),(error) => error===privateWorkError);
  const before=state.loads.length;state.pools[0].emit('error',new Error('private idle socket'));
  assert.equal(service.isAvailable(),false);await assert.rejects(service.transaction(() => assert.fail('unhealthy')),unavailable);assert.equal(state.loads.length,before);await service.close();
});
test('the returned pool never caches admission: later excess grants refuse work until explicitly removed',async () => {
  if(process.platform!=='win32')return;
  const {catalog}=await fixture(),service=await openWindowsDatabaseService(input());let entered=0;
  await service.transaction(() => ++entered);catalog.state.grantedBody=true;
  await assert.rejects(service.transaction(() => ++entered),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});assert.equal(entered,1);
  catalog.state.grantedBody=false;await service.transaction(() => ++entered);assert.equal(entered,2);await service.close();
});
test('close waits for a late credential load after driver failure and zeros its bytes instead of returning it',async () => {
  if(process.platform!=='win32')return;
  let resolveLoad;const gate=new Promise((yes) => {resolveLoad=yes;});
  const {state}=await fixture({load:async(s) => {if(s.loads.length>1)await gate;return Buffer.alloc(64,65);}});
  const service=await openWindowsDatabaseService(input());
  const rejected=assert.rejects(service.transaction(() => assert.fail('closing')),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
  await new Promise((yes) => setImmediate(yes));let closed=false;const closing=service.close().then(() => {closed=true;});
  await new Promise((yes) => setImmediate(yes));assert.equal(closed,false);resolveLoad();await rejected;await closing;
  assert.ok(state.buffers.every((bytes) => bytes.every((byte) => byte===0)));assert.equal(state.ended,1);
});
test('close failures are fixed, sticky and never repeat end or reopen a connection',async () => {
  if(process.platform!=='win32')return;
  const {state}=await fixture({end:async() => {throw new Error('private close');}}),service=await openWindowsDatabaseService(input());
  const first=service.close();assert.equal(service.close(),first);await assert.rejects(first,unavailable);
  await assert.rejects(service.close(),unavailable);assert.equal(state.ended,1);await assert.rejects(service.transaction(() => {}),unavailable);
});

const stagePairs = (events) => events.map(({stage,edge}) => `${stage}:${edge}`);
test('optional startup observation distinguishes actual connection, privilege validation and transaction without changing SQL',async () => {
  if(process.platform!=='win32')return;
  const events=[],{state}=await fixture(),base=await openWindowsDatabaseService(input());
  const baseline=[...state.queries];await base.close();state.queries.length=0;
  const observed=await openWindowsDatabaseService(input(),{onStage:event=>events.push(event)});
  assert.deepEqual(state.queries,baseline);
  assert.deepEqual(stagePairs(events),['transaction:begin','connection:begin','connection:complete',
    'privilege-check:begin','privilege-check:complete','transaction:complete']);
  for(const event of events){assert.deepEqual(Object.keys(event),['stage','edge','elapsedMs']);assert(Object.isFrozen(event));
    assert(WINDOWS_DATABASE_STAGES.includes(event.stage));assert(Number.isSafeInteger(event.elapsedMs)&&event.elapsedMs>=0);}
  assert.equal(JSON.stringify(events).includes('cb_worker'),false);assert.equal(JSON.stringify(events).includes('E:'),false);
  await observed.close();assert.equal(state.ended,2);
});
test('connection and privilege failures emit distinct fixed boundaries while preserving generic public errors and cleanup',async () => {
  if(process.platform!=='win32')return;
  for(const mode of ['connection','privilege','commit']){
    const events=[],{catalog,state}=await fixture(mode==='connection'?{connect:async()=>{throw Error('private connection details');}}:{commitFail:mode==='commit'});
    if(mode==='privilege')catalog.state.grantedBody=true;
    await assert.rejects(openWindowsDatabaseService(input(),{onStage:event=>events.push(event)}),unavailable);
    const pairs=stagePairs(events);
    assert(pairs.includes(mode==='connection'?'connection:failed':mode==='privilege'?'privilege-check:failed':'privilege-check:complete'));
    assert.equal(pairs.at(-1),'transaction:failed');assert.equal(state.ended,1);
    if(mode==='connection')assert.equal(pairs.some(pair=>pair.startsWith('privilege-check:')),false);
    assert.equal(JSON.stringify(events).includes('private'),false);mock.restoreAll();
  }
});
test('observer exceptions and rejected promises neither skip privilege enforcement nor abandon a healthy operation',async () => {
  if(process.platform!=='win32')return;
  for(const onStage of [()=>{throw Error('private observer');},()=>Promise.reject(Error('private observer')),
    ()=>new Promise(()=>{})]){
    const {catalog,state}=await fixture(),service=await openWindowsDatabaseService(input(),{onStage});
    assert.equal(await service.transaction(async tx=>(await tx.query('SELECT $1',['synthetic'])).rows[0].value),'synthetic');
    catalog.state.grantedBody=true;let entered=false;
    await assert.rejects(service.transaction(()=>{entered=true;}),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
    assert.equal(entered,false);await service.close();assert.equal(state.ended,1);
    await new Promise(resolve=>setImmediate(resolve));mock.restoreAll();
  }
});
test('observed caller work errors and unknown commit failures are not mislabeled as privilege rejection',async () => {
  if(process.platform!=='win32')return;
  const events=[],{state}=await fixture(),service=await openWindowsDatabaseService(input(),{onStage:event=>events.push(event)});
  events.length=0;const expected=Error('synthetic private business failure');
  await assert.rejects(service.transaction(()=>{throw expected;}),error=>error===expected);
  assert.deepEqual(stagePairs(events),['transaction:begin','connection:begin','connection:complete',
    'privilege-check:begin','privilege-check:complete','transaction:failed']);
  assert.equal(JSON.stringify(events).includes(expected.message),false);await service.close();assert.equal(state.ended,1);
});
