// Synthetic test orchestration only. The caller supplies operations restricted
// to its fresh restore directory; this module opens no files or services.
import assert from 'node:assert/strict';

export async function exercisePreparedRecoveryFaults({samples,files,inspect,check}) {
  assert.equal(samples.length,2);
  assert.equal(samples.filter(sample=>sample.type==='image/png').length,1);
  assert.equal(samples.filter(sample=>['video/mp4','video/webm'].includes(sample.type)).length,1);
  assert.equal(new Set(samples.map(sample=>sample.object)).size,2);
  for(const sample of samples){
    assert.match(sample.object,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(Buffer.isBuffer(sample.bytes)&&sample.bytes.length>0);
  }
  const recovered=async sample=>{
    assert.deepEqual(await files.read(sample.object),sample.bytes);
    const result=await inspect();
    assert.equal(result.externalFilesMatch,true);assert.deepEqual(result.externalFileDifferences,[]);
  };
  for(const sample of samples){
    await check(`native ${sample.type} candidate corruption is detected and exact synthetic bytes are restored`,async()=>{
      assert.deepEqual(await files.read(sample.object),sample.bytes);
      const changed=Buffer.from(sample.bytes);changed[0]^=255;
      try{
        await files.write(sample.object,changed);
        const result=await inspect();assert.equal(result.externalFilesMatch,false);
        assert.deepEqual(result.externalFileDifferences,['file-content']);
      }finally{await files.write(sample.object,sample.bytes);changed.fill(0);}
      await recovered(sample);
    });
    await check(`missing native ${sample.type} candidate is detected without automatic recreation`,async()=>{
      assert.deepEqual(await files.read(sample.object),sample.bytes);
      await files.remove(sample.object);
      try{
        const result=await inspect();assert.equal(result.externalFilesMatch,false);
        assert.deepEqual(result.externalFileDifferences,['file-inventory']);
      }finally{await files.create(sample.object,sample.bytes);}
      await recovered(sample);
    });
  }
}
