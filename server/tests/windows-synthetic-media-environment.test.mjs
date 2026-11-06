import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsSyntheticMediaEnvironment} from '../windows-native-media-test-fixture.mjs';
test('synthetic media rejects invalid ownership/cancellation contracts before native allocation',()=>{
  for(const options of [{signal:{}},{onOwned:true}])assert.throws(()=>createWindowsSyntheticMediaEnvironment(options),/WINDOWS_NATIVE_MEDIA_FIXTURE_UNAVAILABLE/);
});
test('pre-aborted synthetic media retains a close handle and allocates no runtime',async()=>{
  let owned;const controller=new AbortController();controller.abort();
  await assert.rejects(createWindowsSyntheticMediaEnvironment({signal:controller.signal,onOwned:value=>{owned=value;}}),error=>{
    assert.equal(error.message,'WINDOWS_NATIVE_MEDIA_FIXTURE_UNAVAILABLE');assert.equal(error.diagnostic.retained,false);return true;
  });
  assert(owned);await owned.close();assert.equal(Object.keys(owned.diagnostics()).length,3);
});
