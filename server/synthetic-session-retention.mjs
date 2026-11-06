// Admission evidence for opt-in synthetic sessions only. No arbitrary paths,
// password recovery, schema repair or adoption of historical fixture folders.
import assert from 'node:assert/strict';
import {createHash,createPrivateKey,X509Certificate} from 'node:crypto';
import {lstat,open,readdir,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {TextDecoder} from 'node:util';
import {databasePrivilegePlan} from './database-privilege-policy.mjs';
import {regularDirectoryChain,freshFile} from './windows-synthetic-postgres-runtime.mjs';
const failure=()=>new Error('SYNTHETIC_SESSION_RETENTION_UNAVAILABLE');
export const retainedPurpose='carebridge-synthetic-resumable-session';
export const retainedReceiptName='.carebridge-resumable-session.json';
export const closedReceiptName='.carebridge-resumable-closed.json';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export async function retainedFile(path,maximum=262144){
  let handle,bytes;
  try{
    const before=await lstat(path,{bigint:true});
    assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>0n&&before.size<=BigInt(maximum));
    handle=await open(path,'r');assert(same(before,await handle.stat({bigint:true})));
    bytes=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);assert(bytesRead>0);offset+=bytesRead;}
    assert(same(before,await handle.stat({bigint:true}))&&same(before,await lstat(path,{bigint:true})));
    return {bytes,seal:{...identity(before),size:String(before.size),sha256:sha256(bytes)}};
  }catch{bytes?.fill(0);throw failure();}finally{await handle?.close();}
}
export async function retainedJson(path){
  const {bytes,seal}=await retainedFile(path,16384);
  try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),value=JSON.parse(text);
    assert.equal(JSON.stringify(value),text);return {value,seal};}catch{throw failure();}finally{bytes.fill(0);}
}
export async function consumeClosedReceipt(path,seal){
  const current=await retainedFile(path,16384);
  try{assert.deepEqual(current.seal,seal);}finally{current.bytes.fill(0);}
  await unlink(path); // Only the verified exact receipt under our exclusive lock.
}
export function retentionReceipt(sessionId,vaultId){
  if(!uuid(sessionId)||!uuid(vaultId))throw failure();
  return {schema:1,purpose:retainedPurpose,sessionId,vaultId};
}
export function validateRetentionReceipt(value,sessionId){
  if(!exact(value,['schema','purpose','sessionId','vaultId'])||!uuid(value.vaultId))throw failure();
  assert.deepEqual(value,retentionReceipt(sessionId,value.vaultId));return value;
}
export function retainedSeed(seed){
  const value={centerId:seed.centerId,manager:{userId:seed.manager.userId},therapist:{userId:seed.therapist.userId},
    guardian:{userId:seed.guardian.userId},rooms:seed.rooms.map(room=>({...room}))};
  validateSeed(value);return value;
}
function validateSeed(value){
  assert(exact(value,['centerId','manager','therapist','guardian','rooms'])&&id(value.centerId));
  for(const role of ['manager','therapist','guardian'])assert(exact(value[role],['userId'])&&id(value[role].userId));
  assert(Array.isArray(value.rooms)&&value.rooms.length===2);
  for(const room of value.rooms)assert(exact(room,['childId','conversationId','goalId','appointmentId'])&&Object.values(room).every(id));
}
export function restoreRetainedSeed(value){
  validateSeed(value);const seed=structuredClone(value);
  Object.defineProperties(seed,{credentials:{value:Object.freeze([])},forgetCredentials:{value:()=>{}}});
  return Object.freeze(seed);
}
export async function schemaManifest(){
  const directory=new URL('./migrations/',import.meta.url),names=(await readdir(directory)).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  const rows=await Promise.all(names.map(async name=>({name,checksum:sha256(await readFile(new URL(name,directory)))})));
  return {rows,sha256:sha256(JSON.stringify(rows))};
}
export async function captureRetentionFiles(root,credentialRoot,credentialIds){
  if(!exact(credentialIds,['runtime','worker'])||!Object.values(credentialIds).every(uuid)||credentialIds.runtime===credentialIds.worker)throw failure();
  await regularDirectoryChain(root);await regularDirectoryChain(join(root,'source'));await regularDirectoryChain(join(root,'source-media'));
  await regularDirectoryChain(credentialRoot);
  const files={};
  const paths=[['root','.carebridge-check.json'],...['postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf','PG_VERSION'].map(name=>['source',name]),
    ['credentials','.carebridge-database-credentials.json'],...['runtime','worker'].map(kind=>['credentials',`${credentialIds[kind]}.dpapi`])];
  for(const [kind,name]of paths){
    const path=join(kind==='credentials'?credentialRoot:kind==='source'?join(root,'source'):root,name),value=await retainedFile(path);
    try{files[`${kind}/${name}`]=value.seal.sha256;}finally{value.bytes.fill(0);}
  }
  return {root:identity(await lstat(root,{bigint:true})),media:identity(await lstat(join(root,'source-media'),{bigint:true})),files};
}
export function validateRetainedPayload(value,{sessionId,root,vaultId,now=Date.now()}){
  try{
    assert(exact(value,['schema','purpose','sessionId','root','vaultId','adminPassword','port','systemIdentifier','privileges','credentialIds','seed','tls','evidence','schemaHash']));
    assert(value.schema===1&&value.purpose===retainedPurpose&&value.sessionId===sessionId&&value.root===root&&value.vaultId===vaultId&&uuid(sessionId)&&uuid(vaultId));
    assert(typeof value.adminPassword==='string'&&/^[a-f0-9]{64}$/.test(value.adminPassword));
    assert(Number.isInteger(value.port)&&value.port>=1024&&value.port<=65535&&/^[1-9][0-9]{0,19}$/.test(value.systemIdentifier));
    assert(exact(value.credentialIds,['runtime','worker'])&&Object.values(value.credentialIds).every(uuid)&&value.credentialIds.runtime!==value.credentialIds.worker);
    const plan=databasePrivilegePlan(value.privileges);assert.equal(plan.target.name,'carebridge_synthetic');
    validateSeed(value.seed);assert(/^[a-f0-9]{64}$/.test(value.schemaHash));
    assert(exact(value.tls,['certificate','privateKey','receipt']));
    assert(typeof value.tls.certificate==='string'&&value.tls.certificate.length<4096&&typeof value.tls.privateKey==='string'&&value.tls.privateKey.length<4096);
    const certificate=new X509Certificate(value.tls.certificate);
    assert(certificate.checkIP('127.0.0.1')==='127.0.0.1'&&certificate.checkPrivateKey(createPrivateKey(value.tls.privateKey)));
    assert(Date.parse(certificate.validFrom)<=now&&now<Date.parse(certificate.validTo));
    const receipt=JSON.parse(value.tls.receipt);
    assert(exact(receipt,['schema','purpose','runId','root','operatorSid'])&&receipt.schema===1&&receipt.purpose==='synthetic-postgres-tls'&&receipt.runId===sessionId&&receipt.root===join(root,'tls'));
    assert(exact(value.evidence,['root','media','files']));
    for(const kind of ['root','media'])assert(exact(value.evidence[kind],['dev','ino'])&&Object.values(value.evidence[kind]).every(item=>typeof item==='string'&&/^\d+$/.test(item)));
    assert(value.evidence.files&&Object.keys(value.evidence.files).length===9&&Object.values(value.evidence.files).every(item=>/^[a-f0-9]{64}$/.test(item)));
    return value;
  }catch{throw failure();}
}
export async function writeClosedReceipt(root,receipt){await freshFile(join(root,closedReceiptName),JSON.stringify({...receipt,closed:true}));}
