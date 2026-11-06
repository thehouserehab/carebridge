import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSyntheticVideoBytes,NATIVE_SYNTHETIC_VIDEO} from '../../tests/native-video-fixture.mjs';
import {syntheticVideoBytes} from '../../tests/browser-media-fixture.mjs';
import {prepareVideoDerivative} from '../video-metadata.mjs';
test('unprepared synthetic MP4 is stable, independently copied and eligible for metadata preparation only',()=>{
  const first=nativeSyntheticVideoBytes(),second=nativeSyntheticVideoBytes();assert.notEqual(first,second);
  first.fill(0);assert.equal(second.length,NATIVE_SYNTHETIC_VIDEO.size);
  const prepared=prepareVideoDerivative(second,'video/mp4');
  assert.equal(prepared.mediaAcceptanceReady,false);assert.equal(prepared.source.sha256,NATIVE_SYNTHETIC_VIDEO.sha256);
  // MP4 units count mdat payload boxes, not decoded frames.
  assert.equal(prepared.derivative.size,second.length);assert.equal(prepared.containerMediaUnits,1);
});
test('browser-playable WebM extra block remains unsupported rather than weakening preparation policy',()=>{
  assert.throws(()=>prepareVideoDerivative(syntheticVideoBytes(),'video/webm'),error=>error.code==='SCAN_UNAVAILABLE'&&error.elementId===0x75a1);
});
