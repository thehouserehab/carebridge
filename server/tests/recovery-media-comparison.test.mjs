import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { approveRecoveryMediaRoots, compareRecoveryMediaState, RecoveryMediaComparisonError } from '../recovery-media-comparison.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ok = { externalFilesChecked:true,externalFilesMatch:true,externalFileDifferences:[],filesystemWriterQuiescenceVerified:false };
const errorCode = code => error => {
  assert.ok(error instanceof RecoveryMediaComparisonError); assert.equal(error.code, code);
  assert.equal(error.message, code); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
};
const tables = () => ({objects:[],uploads:[],preparations:[]});
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'carebridge-media-compare-')), identity = await fs.lstat(root, {bigint:true});
  t.after(async () => {
    t.mock.restoreAll();
    const actual = await fs.lstat(root, {bigint:true});
    assert.equal(dirname(root), resolve(tmpdir())); assert.ok(root.startsWith(join(resolve(tmpdir()), 'carebridge-media-compare-')));
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink());
    assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
    assert.equal(resolve(await fs.realpath(root)), resolve(root));
    await fs.rm(root, {recursive:true,force:true});
  });
  const roots = {};
  for (const side of ['source','target']) {
    const path = join(root, side); await fs.mkdir(path, {mode:0o700});
    const info = await fs.lstat(path, {bigint:true}); roots[side] = {path,dev:String(info.dev),ino:String(info.ino)};
  }
  const state = {source:tables(),target:tables()}, queries=[];
  const transaction = side => ({async query(sql, values) {
    queries.push({side,sql,values}); assert.match(sql, /^SELECT /); assert.match(sql, /LIMIT \$1$/); assert.deepEqual(values,[10001]);
    const key = sql.includes('cb_media_objects') ? 'objects' : sql.includes('cb_media_uploads') ? 'uploads' : sql.includes('cb_media_preparations') ? 'preparations' : null;
    assert.ok(key, 'Only the three bounded media projections may be read'); return {rows:structuredClone(state[side][key])};
  }});
  const tx = {source:transaction('source'),target:transaction('target')};
  const writeBoth = async (name, bytes) => { for (const side of ['source','target']) await fs.writeFile(join(roots[side].path,name),bytes,{mode:0o600}); };
  const add = async ({prepared=false,legacy=false,state:status=prepared?'ready':'quarantined',bytes=Buffer.alloc(180031,67)}={}) => {
    const key=randomUUID(),id=randomUUID(),candidate=prepared?randomUUID():null,proof=prepared?randomUUID():null;
    const derivative=Buffer.alloc(70013,82);
    const upload={center_id:'synthetic-center',conversation_id:'synthetic-room',id,state:status,type:'image/png',size:bytes.length,sha256:digest(bytes),version:5,
      object_key:key,candidate_key:candidate,preparation_required:!legacy,preparation_id:proof,prepared_size:prepared?derivative.length:null,
      prepared_sha256:prepared?digest(derivative):null,lease_id:null,lease_until:null};
    const object={key,center_id:upload.center_id,conversation_id:upload.conversation_id,upload_id:id,state:'active'};
    for(const side of ['source','target']) {
      state[side].uploads.push(structuredClone(upload)); state[side].objects.push(structuredClone(object));
      if(prepared) {
        state[side].objects.push({...object,key:candidate});
        state[side].preparations.push({id:proof,center_id:upload.center_id,conversation_id:upload.conversation_id,upload_id:id,source_key:key,derivative_key:candidate,
          type:upload.type,source_size:upload.size,derivative_size:upload.prepared_size,source_sha256:upload.sha256,derivative_sha256:upload.prepared_sha256,upload_version:4});
      }
    }
    await writeBoth(`${key}.blob`,bytes); if(prepared) await writeBoth(`${candidate}.blob`,derivative);
    return {key,id,candidate,proof,bytes,derivative,upload};
  };
  return {root,roots,state,tx,queries,writeBoth,add,run:() => compareRecoveryMediaState(tx.source,tx.target,approveRecoveryMediaRoots(roots))};
}
async function fingerprint(roots) {
  const result={};
  for(const side of ['source','target']) {
    result[side]=[];
    for(const name of (await fs.readdir(roots[side].path)).sort()) {
      const path=join(roots[side].path,name),stat=await fs.lstat(path,{bigint:true});
      result[side].push([name,String(stat.dev),String(stat.ino),String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs),digest(await fs.readFile(path))]);
    }
  }
  return result;
}

test('empty owned roots and empty locked ledgers produce the exact non-release result',async t=>{
  const f=await fixture(t); assert.deepEqual(await f.run(),ok); assert.equal(f.queries.length,6);
  assert.deepEqual(await fs.readdir(f.roots.source.path),[]); assert.deepEqual(await fs.readdir(f.roots.target.path),[]);
});
test('streams every source/candidate byte and preserves legacy original, orphan fences and all files',async t=>{
  const f=await fixture(t); await f.add({prepared:true}); await f.add({legacy:true,state:'bound'});
  const deleted=await f.add();
  for(const side of ['source','target']) {
    const upload=f.state[side].uploads.find(row=>row.id===deleted.id); upload.state='deleted';
    f.state[side].objects.find(row=>row.key===deleted.key).state='deleted';
    await fs.unlink(join(f.roots[side].path,`${deleted.key}.blob`));
  }
  const orphan=randomUUID();
  for(const side of ['source','target']) f.state[side].objects.push({key:orphan,center_id:'synthetic-center',conversation_id:'synthetic-room',upload_id:deleted.id,state:'deleted'});
  await f.writeBoth(`${deleted.key}.blocked`,Buffer.alloc(0)); await f.writeBoth(`${orphan}.blocked`,Buffer.alloc(0));
  await f.writeBoth(`${randomUUID()}.blocked`,Buffer.alloc(0));
  const before=await fingerprint(f.roots),dbBefore=structuredClone(f.state);
  assert.deepEqual(await f.run(),ok); assert.deepEqual(await fingerprint(f.roots),before); assert.deepEqual(f.state,dbBefore);
});
test('deleted current candidate without preparation proof is verified as a fence, never served as bytes',async t=>{
  const f=await fixture(t),item=await f.add(),candidate=randomUUID();
  for(const side of ['source','target']) {
    f.state[side].uploads[0].state='deleted'; f.state[side].uploads[0].candidate_key=candidate;
    f.state[side].objects[0].state='deleted'; f.state[side].objects.push({...f.state[side].objects[0],key:candidate});
    await fs.unlink(join(f.roots[side].path,`${item.key}.blob`));
  }
  await f.writeBoth(`${item.key}.blocked`,Buffer.alloc(0)); await f.writeBoth(`${candidate}.blocked`,Buffer.alloc(0)); assert.deepEqual(await f.run(),ok);
});
test('pending retry retains historical deleted fences without inventing an active object',async t=>{
  const f=await fixture(t),item=await f.add();
  for(const side of ['source','target']) {
    f.state[side].uploads[0].state='pending'; f.state[side].uploads[0].object_key=null;
    f.state[side].objects[0].state='deleted'; await fs.unlink(join(f.roots[side].path,`${item.key}.blob`));
  }
  await f.writeBoth(`${item.key}.blocked`,Buffer.alloc(0)); assert.deepEqual(await f.run(),ok);
});
test('completed preparation remains linked when original and candidate are both deleted',async t=>{
  const f=await fixture(t),item=await f.add({prepared:true});
  for(const side of ['source','target']) {
    f.state[side].uploads[0].state='deleted';
    for(const object of f.state[side].objects) { object.state='deleted'; await fs.unlink(join(f.roots[side].path,`${object.key}.blob`)); }
  }
  await f.writeBoth(`${item.key}.blocked`,Buffer.alloc(0)); await f.writeBoth(`${item.candidate}.blocked`,Buffer.alloc(0));
  assert.deepEqual(await f.run(),ok);
});
test('missing files on one or both sides cannot be reported as a match',async t=>{
  const f=await fixture(t),item=await f.add();
  await fs.unlink(join(f.roots.target.path,`${item.key}.blob`));
  assert.deepEqual((await f.run()).externalFileDifferences,['file-inventory']);
  await fs.unlink(join(f.roots.source.path,`${item.key}.blob`));
  assert.deepEqual((await f.run()).externalFileDifferences,['file-inventory']);
});
test('same-size changes, equal corruption on both sides and candidate corruption fail full manifest hashes',async t=>{
  const f=await fixture(t),item=await f.add({prepared:true});
  await fs.writeFile(join(f.roots.target.path,`${item.candidate}.blob`),Buffer.alloc(item.derivative.length,90));
  assert.deepEqual((await f.run()).externalFileDifferences,['file-content']);
  await fs.writeFile(join(f.roots.source.path,`${item.candidate}.blob`),Buffer.alloc(item.derivative.length,90));
  assert.deepEqual((await f.run()).externalFileDifferences,['file-content']);
});
test('new orphan fence and unexpected fence beside active bytes are visible differences',async t=>{
  const f=await fixture(t),item=await f.add();
  await fs.writeFile(join(f.roots.source.path,`${randomUUID()}.blocked`),Buffer.alloc(0));
  assert.deepEqual((await f.run()).externalFileDifferences,['deletion-fence']);
  await f.writeBoth(`${item.key}.blocked`,Buffer.alloc(0));
  assert.deepEqual((await f.run()).externalFileDifferences,['deletion-fence']);
});
test('deleted ledger requires fence even when both byte files are absent; residual bytes are never ignored',async t=>{
  const f=await fixture(t),item=await f.add();
  for(const side of ['source','target']) { f.state[side].uploads[0].state='deleted'; f.state[side].objects[0].state='deleted'; }
  await f.writeBoth(`${item.key}.blocked`,Buffer.alloc(0)); assert.deepEqual((await f.run()).externalFileDifferences,['deletion-fence']);
  for(const side of ['source','target']) { await fs.unlink(join(f.roots[side].path,`${item.key}.blob`)); await fs.unlink(join(f.roots[side].path,`${item.key}.blocked`)); }
  assert.deepEqual((await f.run()).externalFileDifferences,['deletion-fence']);
});
test('nonempty fence, unknown blob, arbitrary names and subdirectories are safely refused',async t=>{
  const f=await fixture(t),name=`${randomUUID()}.blocked`,path=join(f.roots.source.path,name);
  await fs.writeFile(path,'synthetic fence payload'); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_INVALID_FENCE')); await fs.unlink(path);
  const unknown=join(f.roots.source.path,`${randomUUID()}.blob`); await fs.writeFile(unknown,'synthetic');
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNRECOGNIZED_FILE')); await fs.unlink(unknown);
  const arbitrary=join(f.roots.source.path,'not-an-object.txt'); await fs.writeFile(arbitrary,'synthetic');
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNRECOGNIZED_FILE')); await fs.unlink(arbitrary);
  await fs.mkdir(path); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNRECOGNIZED_FILE'));
});
test('approval is frozen, exact and rejects broad, overlapping or imprecise identity inputs without IO',async t=>{
  const f=await fixture(t),approved=approveRecoveryMediaRoots(f.roots);
  assert.ok(Object.isFrozen(approved)&&Object.isFrozen(approved.source)&&Object.isFrozen(approved.target)); assert.notEqual(approved.source,f.roots.source);
  const project=fileURLToPath(new URL('../../',import.meta.url));
  for(const patch of [{extra:true},{source:f.roots.target},{source:{...f.roots.source,ino:0}},
    {source:{...f.roots.source,ino:'0'}},{source:{...f.roots.source,dev:'01'}},{source:{...f.roots.source,dev:'18446744073709551616'}},
    ...['.',tmpdir(),homedir(),project,join(project,'private'),join(f.roots.target.path,'nested')].map(path=>({source:{...f.roots.source,path}}))])
    assert.throws(()=>approveRecoveryMediaRoots({...f.roots,...patch}),errorCode('RECOVERY_MEDIA_INVALID_INPUT'));
  if(process.platform==='win32') for(const path of ['C:\\','\\\\host\\share','C:\\NUL','C:\\unsafe.','C:\\unsafe:stream'])
    assert.throws(()=>approveRecoveryMediaRoots({...f.roots,source:{...f.roots.source,path}}),errorCode('RECOVERY_MEDIA_INVALID_INPUT'));
});
test('root replacement and caller mutation after the first await cannot redirect a comparison',async t=>{
  const f=await fixture(t),bad=structuredClone(f.roots); bad.source.ino=String(BigInt(bad.source.ino)+1n);
  await assert.rejects(compareRecoveryMediaState(f.tx.source,f.tx.target,approveRecoveryMediaRoots(bad)),errorCode('RECOVERY_MEDIA_ROOT_MISMATCH'));
  const input=structuredClone(f.roots),promise=compareRecoveryMediaState(f.tx.source,f.tx.target,input);
  input.target.path=join(f.root,'never-created'); input.source.ino='1'; f.tx.target.query=()=>{throw Error('replaced query');};
  assert.deepEqual(await promise,ok); await assert.rejects(fs.lstat(input.target.path),{code:'ENOENT'});
  await fs.rename(f.roots.source.path,join(f.root,'owned-previous-root')); await fs.mkdir(f.roots.source.path,{mode:0o700});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_ROOT_MISMATCH'));
});
test('hardlinked objects and a junction/symlink root are rejected without changing targets',async t=>{
  const f=await fixture(t),item=await f.add(),path=join(f.roots.source.path,`${item.key}.blob`),extra=join(f.root,'owned-hardlink');
  await fs.link(path,extra); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNRECOGNIZED_FILE')); await fs.unlink(extra);
  const alias=join(f.root,'alias');
  try { await fs.symlink(f.roots.source.path,alias,process.platform==='win32'?'junction':'dir'); }
  catch(error) { if(['EPERM','EACCES'].includes(error.code)) { t.diagnostic('Native directory-link creation unavailable; hardlink rejection was verified.'); return; } throw error; }
  await assert.rejects(compareRecoveryMediaState(f.tx.source,f.tx.target,approveRecoveryMediaRoots({...f.roots,source:{...f.roots.source,path:alias}})),errorCode('RECOVERY_MEDIA_ROOT_MISMATCH'));
  assert.deepEqual(await fs.readFile(path),item.bytes);
});
test('stable quarantined source works but leases, deletion in flight and ambiguous active objects do not',async t=>{
  const f=await fixture(t); await f.add(); assert.deepEqual(await f.run(),ok);
  for(const status of ['receiving','inspecting','delete_pending']) {
    f.state.source.uploads[0].state=status; await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_IN_FLIGHT'));
  }
  f.state.source.uploads[0].state='quarantined'; f.state.source.uploads[0].lease_id=randomUUID(); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_IN_FLIGHT'));
  f.state.source.uploads[0].lease_id=null; f.state.source.objects.push({...f.state.source.objects[0],key:randomUUID()});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LEDGER_UNAVAILABLE'));
});
test('required preparation must bind the exact owner, source, candidate and both immutable manifests',async t=>{
  const f=await fixture(t); await f.add({prepared:true}); const clean=structuredClone(f.state.source);
  for(const mutate of [s=>{s.preparations=[];},s=>{s.preparations[0].source_sha256='0'.repeat(64);},s=>{s.preparations[0].upload_id=randomUUID();},
    s=>{s.uploads[0].candidate_key=s.uploads[0].object_key;},s=>{s.uploads[0].preparation_id=null;},s=>{s.preparations[0].derivative_key=randomUUID();},
    s=>{s.uploads[0].version=s.preparations[0].upload_version;},s=>{s.objects.push({...s.objects[0]});}]) {
    f.state.source=structuredClone(clean); mutate(f.state.source); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LEDGER_UNAVAILABLE'));
  }
});
test('all initial files are rechecked after the other directory has been hashed',async t=>{
  const f=await fixture(t),item=await f.add(),originalOpen=fs.open.bind(fs); let changed=false;
  t.mock.method(fs,'open',async(path,...args)=>{
    const handle=await originalOpen(path,...args);
    if(!changed&&path===join(f.roots.target.path,`${item.key}.blob`)) { changed=true; await fs.writeFile(join(f.roots.source.path,`${item.key}.blob`),Buffer.alloc(item.bytes.length,90)); }
    return handle;
  });
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_CHANGED')); assert.equal(changed,true);
});
test('mid-stream mutation and same-name inode replacement are refused',async t=>{
  const f=await fixture(t),item=await f.add(),path=join(f.roots.source.path,`${item.key}.blob`),originalOpen=fs.open.bind(fs); let changed=false;
  t.mock.method(fs,'open',async(name,...args)=>{
    const handle=await originalOpen(name,...args);
    if(name===path) { const read=handle.read.bind(handle); handle.read=async(...values)=>{const result=await read(...values); if(!changed){changed=true;await fs.writeFile(path,Buffer.alloc(item.bytes.length,71));}return result;}; }
    return handle;
  });
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_CHANGED')); t.mock.restoreAll();
  t.mock.method(fs,'open',async(name,...args)=>{
    if(name===path) { await fs.rename(path,join(f.root,'owned-original')); await fs.writeFile(path,item.bytes); }
    return originalOpen(name,...args);
  });
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_CHANGED'));
});
test('same-size single-chunk mutation with unchanged stat metadata cannot produce a match',async t=>{
  const f=await fixture(t),item=await f.add({bytes:Buffer.alloc(1024,67)});
  const path=join(f.roots.source.path,`${item.key}.blob`),changedBytes=Buffer.alloc(item.bytes.length,71);
  const initial=await fs.lstat(path,{bigint:true}),originalStat=fs.lstat.bind(fs),originalOpen=fs.open.bind(fs);
  let changed=false;
  // Real bytes and real reads/writes. Only this file's stat observations are
  // frozen to deterministically reproduce the equal timestamps observed on
  // Windows. The first read returns the old complete file, then disk changes.
  t.mock.method(fs,'lstat',async(name,...args)=>name===path?initial:originalStat(name,...args));
  t.mock.method(fs,'open',async(name,...args)=>{
    const handle=await originalOpen(name,...args);
    if(name===path) {
      const read=handle.read.bind(handle);
      handle.stat=async()=>initial;
      handle.read=async(...values)=>{
        const result=await read(...values);
        if(!changed&&result.bytesRead>0) {changed=true;await fs.writeFile(path,changedBytes);}
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_CHANGED'));
  assert.equal(changed,true); assert.deepEqual(await fs.readFile(path),changedBytes);
  assert.deepEqual(await fs.readFile(join(f.roots.target.path,`${item.key}.blob`)),item.bytes);
});
for(const resource of ['file','directory']) test(`deadline after ${resource} acquisition still closes the owned descriptor`,async t=>{
  const f=await fixture(t); await f.add(); let expired=false,closed=0;
  t.mock.method(performance,'now',()=>expired?21000:0);
  const method=resource==='file'?'open':'opendir',original=fs[method].bind(fs);
  t.mock.method(fs,method,async(...args)=>{
    const handle=await original(...args),close=handle.close.bind(handle);
    handle.close=async()=>{closed++;return close();}; expired=true; return handle;
  });
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_TIMEOUT')); assert.equal(closed,1);
});
test('bounded ledgers and IO failures never expose raw paths, hashes or causes',async t=>{
  const f=await fixture(t),sentinel=`SYNTHETIC_PRIVATE ${f.root} ${'a'.repeat(64)}`;
  f.tx.source.query=async()=>{throw new Error(sentinel);}; await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNAVAILABLE'));
  f.tx.source.query=async()=>({}); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LEDGER_UNAVAILABLE'));
  f.tx.source.query=async()=>({rows:Array.from({length:10001},()=>({}))}); await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LIMIT'));
  f.tx.source.query=async()=>{const error=new RecoveryMediaComparisonError(sentinel);error.code=sentinel;error.cause=new Error(sentinel);throw error;};
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNAVAILABLE'));
  f.tx.source.query=async()=>{const error=new RecoveryMediaComparisonError('RECOVERY_MEDIA_LIMIT');error.cause=new Error(sentinel);error.privatePath=sentinel;throw error;};
  await assert.rejects(f.run(),error=>{errorCode('RECOVERY_MEDIA_LIMIT')(error);assert.equal(Object.hasOwn(error,'privatePath'),false);return true;});
});
test('directory enumeration refuses the first entry above its bound and closes without reading files',async t=>{
  const f=await fixture(t),original=fs.opendir.bind(fs); let count=0,closed=0;
  t.mock.method(fs,'opendir',async path=>path===f.roots.source.path ? {
    async read(){count++;return {name:`00000000-0000-4000-8000-${count.toString(16).padStart(12,'0')}.blocked`};},
    async close(){closed++;},
  } : original(path));
  t.mock.method(fs,'open',async()=>{throw new Error('Must reject enumeration before file IO');});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LIMIT')); assert.equal(count,20001); assert.equal(closed,1);
});
test('single-file byte bound rejects metadata without allocating or reading a large file',async t=>{
  const f=await fixture(t),item=await f.add({bytes:Buffer.from('synthetic')}),path=join(f.roots.source.path,`${item.key}.blob`),original=fs.lstat.bind(fs);
  t.mock.method(fs,'lstat',async(...args)=>{
    const info=await original(...args);
    return args[0]===path ? Object.assign(Object.create(Object.getPrototypeOf(info)),info,{size:BigInt(50*1024**2+1)}) : info;
  });
  t.mock.method(fs,'open',async()=>{throw new Error('Must reject size before file IO');});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LIMIT'));
});
test('aggregate byte bound is enforced before hashing and without giant synthetic files',async t=>{
  const f=await fixture(t),item=await f.add({bytes:Buffer.from('synthetic')}),base=f.state.source.uploads[0],baseObject=f.state.source.objects[0];
  for(let i=1;i<42;i++) {
    const key=randomUUID(),id=randomUUID();
    f.state.source.uploads.push({...base,id,object_key:key}); f.state.source.objects.push({...baseObject,key,upload_id:id});
  }
  const fileNames=f.state.source.objects.map(row=>`${row.key}.blob`),paths=new Set(fileNames.map(name=>join(f.roots.source.path,name)));
  const nativeInfo=await fs.lstat(join(f.roots.source.path,`${item.key}.blob`),{bigint:true}),originalStat=fs.lstat.bind(fs),originalDirectory=fs.opendir.bind(fs);
  let observed=0;
  t.mock.method(fs,'opendir',async path=>{
    if(path!==f.roots.source.path)return originalDirectory(path);
    let index=0;return {async read(){return index<fileNames.length?{name:fileNames[index++]}:null;},async close(){}};
  });
  t.mock.method(fs,'lstat',async(...args)=>{
    if(!paths.has(args[0]))return originalStat(...args);
    observed++;return Object.assign(Object.create(Object.getPrototypeOf(nativeInfo)),nativeInfo,{size:BigInt(50*1024**2)});
  });
  t.mock.method(fs,'open',async()=>{throw new Error('Must reject total bytes before hashing');});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_LIMIT')); assert.equal(observed,41);
});
test('a close failure is not converted into a successful or partial comparison',async t=>{
  const f=await fixture(t); await f.add(); const original=fs.open.bind(fs);
  t.mock.method(fs,'open',async(...args)=>{const handle=await original(...args),close=handle.close.bind(handle);handle.close=async()=>{await close();throw new Error('SYNTHETIC_PRIVATE_CLOSE');};return handle;});
  await assert.rejects(f.run(),errorCode('RECOVERY_MEDIA_UNAVAILABLE'));
});
