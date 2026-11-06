// In-memory file ports only. No filesystem, DB, keys, processes or listeners.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {exercisePreparedRecoveryFaults} from '../recovery-prepared-faults.mjs';

function fixture({missCorruption=false,missMissing=false,inspectionError=false}={}){
  const samples=[{type:'image/png',object:'11111111-1111-4111-8111-111111111111',bytes:Buffer.from('photo')},
    {type:'video/mp4',object:'22222222-2222-4222-8222-222222222222',bytes:Buffer.from('video')}];
  const data=new Map(samples.map(sample=>[sample.object,Buffer.from(sample.bytes)])),checks=[],events=[];
  const files={
    read:async key=>{assert.ok(data.has(key));return Buffer.from(data.get(key));},
    write:async(key,bytes)=>{assert.ok(data.has(key));events.push('write');data.set(key,Buffer.from(bytes));},
    remove:async key=>{assert.ok(data.has(key));events.push('remove');data.delete(key);},
    create:async(key,bytes)=>{assert.ok(!data.has(key));events.push('create');data.set(key,Buffer.from(bytes));},
  };
  const inspect=async()=>{
    const absent=samples.some(sample=>!data.has(sample.object));
    const changed=samples.some(sample=>data.has(sample.object)&&!sample.bytes.equals(data.get(sample.object)));
    if(inspectionError&&changed)throw new Error('SYNTHETIC_INSPECTION_FAILED');
    const differences=absent&&!missMissing?['file-inventory']:changed&&!missCorruption?['file-content']:[];
    return {externalFilesMatch:differences.length===0,externalFileDifferences:differences};
  };
  return {samples,data,events,files,inspect,checks,check:async(label,work)=>{await work();checks.push(label);}};
}
const intact=f=>{assert.equal(f.data.size,2);for(const sample of f.samples)assert.deepEqual(f.data.get(sample.object),sample.bytes);};

test('photo and video candidate corruption and absence are inspected separately then restored',async()=>{
  const f=fixture();await exercisePreparedRecoveryFaults(f);intact(f);
  assert.equal(f.checks.length,4);assert.deepEqual(f.events,['write','write','remove','create','write','write','remove','create']);
});
test('undetected corruption or missing file fails instead of recording a successful native check',async()=>{
  for(const option of [{missCorruption:true},{missMissing:true},{inspectionError:true}]){
    const f=fixture(option);await assert.rejects(exercisePreparedRecoveryFaults(f));intact(f);
    assert.ok(f.checks.length<4);
  }
});
test('empty, duplicate, path-like and incomplete native sample pairs fail before file operations',async()=>{
  for(const change of [f=>{f.samples=[];},f=>{f.samples[1].object=f.samples[0].object;},
    f=>{f.samples[0].object='../source.blob';},f=>{f.samples[1].type='image/png';},f=>{f.samples[0].bytes=Buffer.alloc(0);}]){
    const f=fixture();change(f);await assert.rejects(exercisePreparedRecoveryFaults(f));assert.deepEqual(f.events,[]);
  }
});
test('changed bytes after restore are not accepted as a completed round trip',async()=>{
  const f=fixture(),write=f.files.write;
  f.files.write=async(key,bytes)=>{await write(key,bytes);if(f.events.length===2)f.data.set(key,Buffer.from('wrong'));};
  await assert.rejects(exercisePreparedRecoveryFaults(f));assert.deepEqual(f.checks,[]);
});
