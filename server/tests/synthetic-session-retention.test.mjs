// Actual owned temporary filesystem + synthetic metadata only. No database,
// E drive, credential provider, native executable, browser or TLS approval.
// Valid TLS custody/admission is intentionally left to the real native check.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {
  retainedPurpose,retainedReceiptName,closedReceiptName,sha256,retainedFile,retainedJson,
  consumeClosedReceipt,retentionReceipt,validateRetentionReceipt,retainedSeed,restoreRetainedSeed,
  schemaManifest,captureRetentionFiles,validateRetainedPayload,writeClosedReceipt,
} from '../synthetic-session-retention.mjs';

const unavailable={message:'SYNTHETIC_SESSION_RETENTION_UNAVAILABLE'};
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const base=await fs.realpath(tmpdir()),root=await fs.mkdtemp(join(base,'carebridge-retention-unit-'));
  const original=await fs.lstat(root,{bigint:true});
  t.after(async()=>{
    const current=await fs.lstat(root,{bigint:true});
    assert.equal(resolve(await fs.realpath(root)),resolve(root)); assert.equal(dirname(resolve(root)),resolve(base));
    assert(basename(root).startsWith('carebridge-retention-unit-'));
    assert(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===original.dev&&current.ino===original.ino);
    await fs.rm(root,{recursive:true});
  });
  return {root,file:name=>join(root,name)};
}
function seed(){
  return {centerId:'synthetic-center',manager:{userId:'synthetic-manager'},therapist:{userId:'synthetic-therapist'},
    guardian:{userId:'synthetic-guardian'},rooms:[1,2].map(index=>({childId:`synthetic-child-${index}`,
      conversationId:`synthetic-room-${index}`,goalId:`synthetic-goal-${index}`,appointmentId:`synthetic-appointment-${index}`}))};
}
async function populate(t){
  const f=await fixture(t),credentialRoot=f.file('credentials'),source=f.file('source'),media=f.file('source-media');
  for(const directory of [credentialRoot,source,media])await fs.mkdir(directory);
  const credentialIds={runtime:randomUUID(),worker:randomUUID()};
  const entries=[['root','.carebridge-check.json'],...['postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf','PG_VERSION'].map(name=>['source',name]),
    ['credentials','.carebridge-database-credentials.json'],...Object.values(credentialIds).map(id=>['credentials',`${id}.dpapi`])];
  const files=new Map();
  for(const [kind,name] of entries){
    const path=join(kind==='root'?f.root:kind==='source'?source:credentialRoot,name),bytes=Buffer.from(`synthetic ${kind}/${name}`);
    await fs.writeFile(path,bytes,{flag:'wx'}); files.set(`${kind}/${name}`,{path,bytes});
  }
  return {...f,credentialRoot,credentialIds,source,media,files,capture:()=>captureRetentionFiles(f.root,credentialRoot,credentialIds)};
}

test('retention receipts bind exact session and vault UUIDs, purpose and field set',()=>{
  const sessionId=randomUUID(),vaultId=randomUUID(),receipt=retentionReceipt(sessionId,vaultId);
  assert.deepEqual(receipt,{schema:1,purpose:retainedPurpose,sessionId,vaultId});
  assert.equal(validateRetentionReceipt(receipt,sessionId),receipt);
  assert.equal(retainedReceiptName,'.carebridge-resumable-session.json'); assert.equal(closedReceiptName,'.carebridge-resumable-closed.json');
  for(const value of [null,'',sessionId.toUpperCase(),'../session','a'.repeat(36)]){
    assert.throws(()=>retentionReceipt(value,vaultId)); assert.throws(()=>retentionReceipt(sessionId,value));
  }
  for(const changed of [null,{},[],{...receipt,sessionId:randomUUID()},{...receipt,vaultId:'../vault'},
    {...receipt,schema:2},{...receipt,purpose:'old-fixture'},{...receipt,closed:true}])assert.throws(()=>validateRetentionReceipt(changed,sessionId));
});

test('retained seed contains only stable IDs and does not serialize credentials or account metadata',()=>{
  const input=seed(); input.credentials=[{email:'synthetic@example.test',password:'synthetic-private-marker'}];
  input.manager.email='synthetic@example.test'; input.therapist.password='synthetic-private-marker'; input.extra='discarded';
  const saved=retainedSeed(input); assert.deepEqual(saved,seed());
  assert.equal(JSON.stringify(saved).includes('synthetic-private-marker'),false); assert.equal(JSON.stringify(saved).includes('@'),false);
  input.rooms[0].goalId='mutated'; input.guardian.userId='mutated'; assert.deepEqual(saved,seed());
  const restored=restoreRetainedSeed(saved); assert.ok(Object.isFrozen(restored)); assert.deepEqual(restored.credentials,[]);
  assert.equal(Object.keys(restored).includes('credentials'),false); assert.equal(Object.keys(restored).includes('forgetCredentials'),false);
  restored.forgetCredentials(); assert.deepEqual(restored.credentials,[]);
  saved.rooms[0].childId='mutated'; assert.equal(restored.rooms[0].childId,'synthetic-child-1');
});

test('seed restoration rejects malformed or additional fields instead of restoring passwords',()=>{
  const changes=[value=>{value.password='synthetic-private-marker';},value=>{value.manager.email='synthetic@example.test';},
    value=>{value.rooms[0].password='synthetic-private-marker';},value=>{value.rooms.pop();},value=>{value.rooms.push({...value.rooms[0]});},
    value=>{value.centerId='../outside';},value=>{value.guardian.userId='';},value=>{delete value.rooms[0].appointmentId;}];
  for(const change of changes){const value=seed();change(value);assert.throws(()=>restoreRetainedSeed(value));}
  for(const value of [null,{},[],{...seed(),rooms:null}])assert.throws(()=>restoreRetainedSeed(value));
});

test('bounded file reads return exact bytes and identity-bound checksum without mutating the file',async t=>{
  const f=await fixture(t),path=f.file('receipt.json'),bytes=Buffer.from('{"synthetic":true}');await fs.writeFile(path,bytes);
  const result=await retainedFile(path,bytes.length),stat=await fs.lstat(path,{bigint:true});
  assert.deepEqual(result.bytes,bytes);assert.deepEqual(result.seal,{dev:String(stat.dev),ino:String(stat.ino),size:String(bytes.length),sha256:digest(bytes)});
  result.bytes.fill(0);assert.deepEqual(await fs.readFile(path),bytes);assert.equal(sha256(bytes),digest(bytes));
  const parsed=await retainedJson(path);assert.deepEqual(parsed.value,{synthetic:true});assert.deepEqual(parsed.seal,result.seal);
});

test('zero, oversized, missing and directory entries are refused without returning contents',async t=>{
  const f=await fixture(t),file=f.file('bounded');await fs.writeFile(file,Buffer.alloc(0));
  await assert.rejects(retainedFile(file),unavailable);await fs.writeFile(file,Buffer.alloc(9,0x61));
  await assert.rejects(retainedFile(file,8),unavailable);await assert.rejects(retainedFile(f.root),unavailable);
  await assert.rejects(retainedFile(f.file('missing')),unavailable);
  await fs.writeFile(file,Buffer.alloc(16385,0x61));await assert.rejects(retainedJson(file),unavailable);
  await fs.writeFile(file,Buffer.alloc(262145,0x61));await assert.rejects(retainedFile(file),unavailable);
});

test('malformed JSON cannot become a retained receipt',async t=>{
  const f=await fixture(t),file=f.file('invalid.json');await fs.writeFile(file,'{"synthetic":');
  await assert.rejects(retainedJson(file));assert.equal(await fs.readFile(file,'utf8'),'{"synthetic":');
});

test('duplicate keys, noncanonical JSON and invalid UTF-8 cannot masquerade as a closed receipt',async t=>{
  const f=await fixture(t),file=f.file('ambiguous.json');
  for(const bytes of [Buffer.from('{"closed":false,"closed":true}'),Buffer.from('{ "closed":true}'),
    Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xff]),Buffer.from('"}')])]){
    await fs.writeFile(file,bytes);await assert.rejects(retainedJson(file),unavailable);
    assert.deepEqual(await fs.readFile(file),bytes);
  }
});

test('credential path traversal and duplicate identities are rejected before filesystem access',async()=>{
  const runId=randomUUID();
  for(const ids of [{runtime:'../../outside',worker:randomUUID()},{runtime:randomUUID()},
    {runtime:runId,worker:runId}])await assert.rejects(captureRetentionFiles('not-a-real-root','not-a-real-credential-root',ids),unavailable);
});

test('hard links and symbolic directory entries are not accepted as single owned regular files',async t=>{
  const f=await fixture(t),file=f.file('original'),linked=f.file('hard-link');await fs.writeFile(file,'synthetic');await fs.link(file,linked);
  await assert.rejects(retainedFile(file),unavailable);await assert.rejects(retainedFile(linked),unavailable);await fs.unlink(linked);
  const target=f.file('target'),symbolic=f.file('symbolic');await fs.mkdir(target);
  await fs.symlink(target,symbolic,process.platform==='win32'?'junction':'dir');
  try{await assert.rejects(retainedFile(symbolic),unavailable);}finally{await fs.unlink(symbolic);}
  const read=await retainedFile(file);read.bytes.fill(0);
});

test('content changed while an actual file handle is being read fails and zeros the returned buffer',async t=>{
  const f=await fixture(t),file=f.file('changing');await fs.writeFile(file,'synthetic-original');
  const originalOpen=fs.open;let observed;
  mock.method(fs,'open',async(...args)=>{
    const handle=await originalOpen(...args);if(args[0]!==file)return handle;
    const read=handle.read.bind(handle);let changed=false;
    handle.read=async(...readArgs)=>{
      observed=readArgs[0];const result=await read(...readArgs);
      if(!changed){changed=true;await fs.writeFile(file,'synthetic-modified');await fs.utimes(file,new Date(0),new Date(0));}
      return result;
    };return handle;
  });syncBuiltinESMExports();
  try{await assert.rejects(retainedFile(file),unavailable);assert(observed&&observed.every(byte=>byte===0));}
  finally{mock.restoreAll();syncBuiltinESMExports();}
  assert.equal(await fs.readFile(file,'utf8'),'synthetic-modified');
});

test('short reads caused by truncation cannot return a partial admitted receipt',async t=>{
  const f=await fixture(t),file=f.file('truncated');await fs.writeFile(file,'synthetic-original');const originalOpen=fs.open;let observed;
  mock.method(fs,'open',async(...args)=>{
    const handle=await originalOpen(...args);if(args[0]!==file)return handle;
    const read=handle.read.bind(handle);handle.read=async(...readArgs)=>{observed=readArgs[0];await fs.truncate(file,0);return read(...readArgs);};return handle;
  });syncBuiltinESMExports();
  try{await assert.rejects(retainedFile(file),unavailable);assert(observed&&observed.every(byte=>byte===0));}
  finally{mock.restoreAll();syncBuiltinESMExports();}
});

test('wrong seals, altered content and replacement inodes leave the closed receipt untouched',async t=>{
  const f=await fixture(t),file=f.file(closedReceiptName);await fs.writeFile(file,'synthetic-completion');
  const first=await retainedFile(file);first.bytes.fill(0);
  for(const patch of [{sha256:'0'.repeat(64)},{size:'1'},{ino:'0'},{dev:'0'}, {extra:true}]){
    await assert.rejects(consumeClosedReceipt(file,{...first.seal,...patch}));assert.equal(await fs.readFile(file,'utf8'),'synthetic-completion');
  }
  await fs.writeFile(file,'synthetic-tampered');await assert.rejects(consumeClosedReceipt(file,first.seal));
  assert.equal(await fs.readFile(file,'utf8'),'synthetic-tampered');
  await fs.rename(file,f.file('old-receipt'));await fs.writeFile(file,'synthetic-completion');
  await assert.rejects(consumeClosedReceipt(file,first.seal));assert.equal(await fs.readFile(file,'utf8'),'synthetic-completion');
});

test('closed receipt uses exclusive synced creation and can be consumed only by its exact current seal',async t=>{
  const f=await fixture(t),receipt={sessionId:randomUUID(),generation:1};await writeClosedReceipt(f.root,receipt);
  const path=f.file(closedReceiptName),read=await retainedJson(path);assert.deepEqual(read.value,{...receipt,closed:true});
  await assert.rejects(writeClosedReceipt(f.root,{...receipt,generation:2}),{code:'EEXIST'});
  assert.deepEqual((await retainedJson(path)).value,read.value);await consumeClosedReceipt(path,read.seal);
  await assert.rejects(fs.lstat(path),{code:'ENOENT'});await assert.rejects(consumeClosedReceipt(path,read.seal),unavailable);
});

test('capture contains exactly nine config and credential hashes plus directory identities, not plaintext',async t=>{
  const f=await populate(t),capture=await f.capture();assert.deepEqual(Object.keys(capture).sort(),['files','media','root']);
  assert.deepEqual(Object.keys(capture.files).sort(),[...f.files.keys()].sort());assert.equal(f.files.size,9);
  for(const [key,value] of f.files)assert.equal(capture.files[key],digest(value.bytes));
  for(const [key,path] of [['root',f.root],['media',f.media]]){
    const stat=await fs.lstat(path,{bigint:true});assert.deepEqual(capture[key],{dev:String(stat.dev),ino:String(stat.ino)});
  }
  assert.equal(JSON.stringify(capture).includes('synthetic credentials/'),false);assert.deepEqual(await f.capture(),capture);
});

test('config byte changes and directory replacement change captured admission evidence',async t=>{
  const f=await populate(t),before=await f.capture(),file=f.files.get('source/postgresql.conf');
  await fs.writeFile(file.path,'synthetic changed configuration');const altered=await f.capture();
  assert.notEqual(altered.files['source/postgresql.conf'],before.files['source/postgresql.conf']);
  for(const key of Object.keys(before.files).filter(key=>key!=='source/postgresql.conf'))assert.equal(altered.files[key],before.files[key]);
  await fs.rename(f.media,f.file('old-media'));await fs.mkdir(f.media);const moved=await f.capture();
  assert.notDeepEqual(moved.media,before.media);assert.deepEqual(moved.root,before.root);assert.deepEqual(moved.files,altered.files);
});

test('capture refuses hard-linked configuration and redirected media ancestors',async t=>{
  const f=await populate(t),file=f.files.get('source/pg_hba.conf').path,linked=f.file('linked-config');await fs.link(file,linked);
  await assert.rejects(f.capture(),unavailable);await fs.unlink(linked);
  const original=f.file('original-media');await fs.rename(f.media,original);
  await fs.symlink(original,f.media,process.platform==='win32'?'junction':'dir');
  try{await assert.rejects(f.capture());assert.deepEqual(await fs.readdir(original),[]);}finally{await fs.unlink(f.media);}
});

test('a missing expected config is refused rather than silently shortening the evidence list',async t=>{
  const f=await populate(t);await fs.unlink(f.files.get('source/pg_ident.conf').path);
  await assert.rejects(f.capture(),unavailable);
});

test('schema manifest is a sorted digest of the exact checked-in SQL bytes, without executing any migration',async()=>{
  const first=await schemaManifest(),second=await schemaManifest(),directory=new URL('../migrations/',import.meta.url);
  const names=(await fs.readdir(directory)).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  assert.deepEqual(first.rows.map(row=>row.name),names);assert.ok(names.length>0);assert.deepEqual(second,first);
  for(const row of first.rows)assert.equal(row.checksum,digest(await fs.readFile(new URL(row.name,directory))));
  assert.equal(first.sha256,digest(JSON.stringify(first.rows)));
  const changed=structuredClone(first.rows);changed[0].checksum='0'.repeat(64);assert.notEqual(digest(JSON.stringify(changed)),first.sha256);
});

test('invalid or missing TLS material fails closed with fixed diagnostics; this is not positive TLS proof',()=>{
  const sessionId=randomUUID(),vaultId=randomUUID(),root='E:\\SyntheticUnitOnly\\source';
  const value={schema:1,purpose:retainedPurpose,sessionId,root,vaultId,adminPassword:'a'.repeat(64),port:50501,systemIdentifier:'7560000000000000123',
    privileges:{roles:{owner:'fixture_owner',runtime:'fixture_runtime',bootstrap:'fixture_bootstrap',backup:'fixture_backup',worker:'fixture_worker'},
      target:{name:'carebridge_synthetic',confirm:'carebridge_synthetic',oid:16384,ownerOid:16385}},
    credentialIds:{runtime:randomUUID(),worker:randomUUID()},seed:seed(),tls:{certificate:'SYNTHETIC INVALID CERTIFICATE',privateKey:'SYNTHETIC INVALID KEY',receipt:'{}'},
    evidence:{root:{dev:'1',ino:'1'},media:{dev:'1',ino:'2'},files:{}},schemaHash:'a'.repeat(64)};
  for(const tls of [value.tls,null,{}, {...value.tls,certificate:''},{...value.tls,certificate:'x'.repeat(4096)}]){
    assert.throws(()=>validateRetainedPayload({...value,tls},{sessionId,root,vaultId,now:0}),error=>
      error.message===unavailable.message&&error.cause===undefined&&!JSON.stringify(error).includes('SYNTHETIC INVALID'));
  }
});
